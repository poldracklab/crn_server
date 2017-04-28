// dependencies ------------------------------------------------------------

import aws     from '../libs/aws';
import scitran from '../libs/scitran';
import crypto  from 'crypto';
import uuid    from 'uuid';
import mongo         from '../libs/mongo';
import {ObjectID}    from 'mongodb';
import archiver      from 'archiver';

let c = mongo.collections;

// handlers ----------------------------------------------------------------

/**
 * Jobs
 *
 * Handlers for job actions.
 */
let handlers = {

    /**
     * Create Job Definition
     */
    createJobDefinition(req, res, next) {
        let jobDef = req.body;

        aws.batch.registerJobDefinition(jobDef, (err, data) => {
            if (err) {
                return next(err);
            } else {
                res.send(data);
            }
        });
    },

    /**
    * Disable Job Definition
    */
    disableJobDefinition(req, res, next) {
        let jobArn = req.body.arn;

        aws.batch.sdk.deregisterJobDefinition({jobDefinition: jobArn}, (err, data) => {
            if (err) {
                return next(err);
            } else {
                res.send(data);
            }
        });
    },

    /**
     * Describe Job Definitions
     */
    describeJobDefinitions(req, res, next) {
        aws.batch.sdk.describeJobDefinitions({}, (err, data) => {
            if (err) {
                return next(err);
            } else {
                let definitions = {};
                for (let definition of data.jobDefinitions) {
                    if (!definitions.hasOwnProperty(definition.jobDefinitionName)) {
                        definitions[definition.jobDefinitionName] = {};
                    }
                    definitions[definition.jobDefinitionName][definition.revision] = definition;
                }

                res.send(definitions);
            }
        });
    },

    /**
     * Submit Job
     * Inserts a job document into mongo and starts snapshot upload
     * returns job to client
     */
    submitJob(req, res, next) {
        let job = req.body;

        job.uploadSnapshotComplete = !!job.uploadSnapshotComplete;
        job.analysis = {
            analysisId: uuid.v4(),
            status: 'UPLOADING',
            created: new Date(),
            attempts: 0
        };
        //making consistent with agave ??
        job.appLabel = job.jobName;
        job.appVersion = job.jobDefinition.match(/\d+$/)[0];

        scitran.downloadSymlinkDataset(job.snapshotId, (err, hash) => {
            job.datasetHash = hash;
            job.parametersHash = crypto.createHash('md5').update(JSON.stringify(job.parameters)).digest('hex');

            // jobDefintion is the full ARN including version, region, etc
            c.crn.jobs.findOne({
                jobDefinition:  job.jobDefinition,
                datasetHash:    job.datasetHash,
                parametersHash: job.parametersHash,
                snapshotId:     job.snapshotId
            }, {}, (err, existingJob) => {
                if (err){return next(err);}
                if (existingJob) {
                    // allow retrying failed jobs
                    if (existingJob.analysis && existingJob.analysis.status === 'FAILED') {
                        handlers.retry({params: {jobId: existingJob.jobId}}, res, next);
                        return;
                    }
                    let error = new Error('A job with the same dataset and parameters has already been run.');
                    error.http_code = 409;
                    res.status(409).send({message: 'A job with the same dataset and parameters has already been run.'});
                    return;
                }

                c.crn.jobs.insertOne(job, (err, mongoJob) => {

                    // Finish the client request so S3 upload can happen async
                    res.send({jobId: mongoJob.insertedId});

                    // TODO - handle situation where upload to S3 fails
                    aws.s3.uploadSnapshot(hash, () => {
                        const batchJobParams = {
                            jobDefinition: job.jobDefinition,
                            jobName:       job.jobName,
                            jobQueue:      'bids-queue',
                            parameters:    job.parameters,
                            containerOverrides:{
                                environment: [{
                                    name: 'BIDS_SNAPSHOT_ID',
                                    value: hash
                                }, {
                                    name: 'BIDS_ANALYSIS_ID',
                                    value: job.analysis.analysisId
                                }]
                            }
                        };

                        aws.batch.startBatchJob(batchJobParams, mongoJob.insertedId);
                    });
                });
            });
        }, {snapshot: true});
    },

    /**
     * GET Job
     */
    getJob(req, res) {
        let jobId = req.params.jobId; //this is the mongo id for the job.

        c.crn.jobs.findOne({_id: ObjectID(jobId)}, {}, (err, job) => {
            if (!job) {
                res.status(404).send({message: 'Job not found.'});
                return;
            }
            let status = job.analysis.status;
            let analysisId = job.analysis.analysisId;
            let jobs = job.analysis.jobs;
            //let totalJobs = jobs.length; //total number of jobs in the analysis
            // check if job is already known to be completed
            // there could be a scenario where we are polling before the AWS batch job has been setup. !jobs check handles this.
            if ((status === 'SUCCEEDED' && job.results && job.results.length > 0) || status === 'FAILED' || !jobs) {
                res.send(job);
            } else {
                let params = {
                    jobs: jobs
                };
                aws.batch.sdk.describeJobs(params, (err, resp) => {
                    let analysis = {};
                    let statusArray = resp.jobs.map((job) => {
                        return job.status;
                    });
                    //if every status is either succeeded or failed, all jobs have completed.
                    let finished = statusArray.every((status) => {
                        return status === 'SUCCEEDED' || status === 'FAILED';
                    });

                    analysis.status = !finished ? 'RUNNING' : 'COMPLETING';
                    // check status
                    if(finished){
                        //Check if any jobs failed, if so analysis failed, else succeeded
                        let finalStatus = statusArray.some((status)=>{ return status === 'FAILED';}) ? 'FAILED' : 'SUCCEEDED';
                        let params = {
                            Bucket: 'openneuro.outputs',
                            Prefix: job.snapshotId + '/' + job.analysis.analysisId
                        };
                        aws.s3.sdk.listObjectsV2(params, (err, data) => {
                            let results = [];
                            data.Contents.forEach((obj) => {
                                let result = {};
                                result.name = obj.Key;
                                result.path = params.Bucket + '/' + obj.Key;
                                results.push(result);
                            });
                            c.crn.jobs.updateOne({_id: ObjectID(jobId)}, {
                                $set:{
                                    'analysis.status': finalStatus,
                                    results: results
                                }
                            });
                        });
                    }
                    res.send({
                        analysis: analysis,
                        jobId: analysisId,
                        datasetId: job.datasetId,
                        snapshotId: job.snapshotId
                    });

                    // notifications.jobComplete(job);

                    // if (resp.body.status === 'error' && resp.body.message.indexOf('No job found with job id') > -1) {
                    //     job.agave.status = 'FAILED';
                    //     c.crn.jobs.updateOne({jobId}, {$set: {agave: job.agave}}, {}, () => {
                    //         res.send({agave: resp.body.result, snapshotId: job.snapshotId});
                    //         notifications.jobComplete(job);
                    //     });
                    // } else if (resp.body && resp.body.result && (resp.body.result.status === 'FINISHED' || resp.body.result.status === 'FAILED')) {
                    //     job.agave = resp.body.result;
                    //     agave.getOutputs(jobId, (results, logs) => {
                    //         c.crn.jobs.updateOne({jobId}, {$set: {agave: resp.body.result, results, logs}}, {}, (err) => {
                    //             if (err) {res.send(err);}
                    //             else {res.send({agave: resp.body.result, results, logs, snapshotId: job.snapshotId});}
                    //             job.agave = resp.body.result;
                    //             job.results = results;
                    //             job.logs = logs;
                    //             if (status !== 'FINISHED') {notifications.jobComplete(job);}
                    //         });
                    //     });
                    // } else if (resp.body && resp.body.result && job.agave.status !== resp.body.result.status) {
                    //     job.agave = resp.body.result;
                    //     c.crn.jobs.updateOne({jobId}, {$set: {agave: resp.body.result}}, {}, (err) => {
                    //         if (err) {res.send(err);}
                    //         else {
                    //             res.send({
                    //                 agave:      resp.body.result,
                    //                 datasetId:  job.datasetId,
                    //                 snapshotId: job.snapshotId,
                    //                 jobId:      jobId
                    //             });
                    //         }
                    //     });
                    // } else {
                    //     res.send({
                    //         agave:      resp.body.result,
                    //         datasetId:  job.datasetId,
                    //         snapshotId: job.snapshotId,
                    //         jobId:      jobId
                    //     });
                    // }
                });
            }
        });
    },

    /**
     * GET File
     * listObjects to find everything in the s3 bucket for a given job
     * stream all files in series(?) to zip 
     */
    downloadAllS3(req, res) {
        let jobId = req.params.jobId;

        const path = req.ticket.filePath;
        if (path === 'all-results' || path === 'all-logs') {

            const type = path.replace('all-', '');

            // initialize archive
            let archive = archiver('zip');

            // log archiving errors
            archive.on('error', (err) => {
                console.log('archiving error - job: ' + jobId);
                console.log(err);
            });

            c.crn.jobs.findOne({jobId}, {}, (err, job) => {
                let archiveName = job.datasetLabel + '__' + job.appId + '__' + type;
                //params to list objects for a job
                let params = {
                    Bucket: 'openneuro.outputs',
                    Prefix: '24fd3a7f24ce267eb488ec5afe5c98c1' || job.snapshotId
                };

                // set archive name
                res.attachment(archiveName + '.zip');

                // begin streaming archive
                archive.pipe(res);

                aws.s3.listObjectsV2(params, (err, data) => {
                    let keysArray = [];
                    data.Contents.forEach((obj) => {
                        keysArray.push(obj.Key;
                    });

                    async.eachSeries(keysArray, (key, cb) => {
                        let objParams = {
                            Bucket: 'openneuro.outputs',
                            Key: key
                        };
                        aws.s3.getObject(objParams, (err, response) => {
                            //append to zip
                            archive.append(res.body, {name: 'test.txt'});
                            cb();
                        });
                    }, () => {
                        archive.finalize();
                    });
                });

                // recurse outputs
                // getOutputs(archiveName, job[type], type, archive, () => {
                //     archive.finalize();
                // });
            });

        }

        // recurse through tree outputs
        function getOutputs(archiveName, results, type, archive, callback) {
            const baseDir = type === 'results' ? '/out/' : '/log/';
            async.eachSeries(results, (result, cb) => {
                let outputName = result.path.replace(baseDir, archiveName + '/');
                if (result.type === 'file') {
                    let path = 'jobs/v2/' + jobId + '/outputs/media' + result.path;
                    agave.api.getPath(path, (err, res) => {
                        let body = res.body;
                        if (body && body.status && body.status === 'error') {
                            // error from AGAVE
                            console.log('Error downloading - ', path);
                            console.log(body);
                        } else {
                            // stringify JSON
                            if (typeof body === 'object' && !Buffer.isBuffer(body)) {
                                body = JSON.stringify(body);
                            }
                            // stringify numbers
                            if (typeof body === 'number') {
                                body = body.toString();
                            }
                            // handle empty files
                            if (typeof body === 'undefined') {
                                body = '';
                            }
                            // append file to archive
                            archive.append(body, {name: outputName});
                        }
                        cb();
                    });
                } else if (result.type === 'dir') {
                    archive.append(null, {name: outputName + '/'});
                    getOutputs(archiveName, result.children, type, archive, cb);
                } else {
                    cb();
                }
            }, callback);
        }

    },

    /**
     * Retry a job using existing parameters
     */
    retry (req, res, next) {
        // let jobId = req.params.jobId;
        // TODO - This is a stub for testing - need to resubmit using the same CRN job data but a new AWS Batch job
        let error = new Error('Retry is not yet supported.');
        error.http_code = 409;
        return next(error);
    }

};

export default handlers;
