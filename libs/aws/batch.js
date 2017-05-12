/*eslint no-console: ["error", { allow: ["log"] }] */
import mongo from '../../libs/mongo';
import async from 'async';
import config from '../../config';

let c = mongo.collections;

/**
 * Converts a list of job Ids into an array of objects as expected by the Batch API
 */
function _depsObjects(depsIds) {
    return depsIds.map((depId) => {
        return {'jobId': depId};
    });
}

export default (aws) => {

    const batch = new aws.Batch();

    return {
        sdk: batch,

        /**
         * Register a job and store some additional metadata with AWS Batch
         */
        registerJobDefinition(jobDef, callback) {
            if(!this._validateInputs(jobDef)) {
                let err = new Error('Invalid Inputs For AWS Batch');
                err.http_code = 400;
                return callback(err);
            }

            let env = jobDef.containerProperties.environment;
            env.push({name: 'BIDS_DATASET_BUCKET', value: config.aws.s3.datasetBucket});
            env.push({name: 'BIDS_OUTPUT_BUCKET', value: config.aws.s3.analysisBucket});
            // This controls this value for the host container
            // child containers are always run without the privileged flag
            jobDef.containerProperties.privileged = true;
            batch.registerJobDefinition(jobDef, callback);
        },

        /**
         * Start AWS Batch Job
         * Returns a promise that succeeds with the queued job id.
         */
        startBatchJob(batchJob, jobId) {
            let promise = new Promise((resolve, reject) => {
                c.crn.jobDefinitions.findOne({jobDefinitionArn: batchJob.jobDefinition}, {}, (err, jobDef) => {
                    let analysisLevels = jobDef.analysisLevels;
                    async.reduce(analysisLevels, [], (deps, level, callback) => {
                        let submitter;
                        let levelName = level.value;

                        // Pass analysis level to the BIDS app container
                        let env = batchJob.containerOverrides.environment;
                        env.push({name: 'BIDS_ANALYSIS_LEVEL', value: levelName});

                        if (levelName.search('participant') != -1) {
                            // Run participant level jobs in parallel
                            submitter = this.submitParallelJobs.bind(this);
                        } else {
                            // Other levels are serial
                            submitter = this.submitSingleJob.bind(this);
                        }
                        submitter(batchJob, deps, (err, batchJobIds) => {
                            // Submit the next set of jobs including the previous as deps
                            if (err) {
                                reject(err);
                            } else {
                                callback(null, deps.concat(batchJobIds));
                            }
                        });
                    }, (err, batchJobIds) => {
                        // When all jobs are submitted, update job state with the last set
                        this._updateJobOnSubmitSuccessful(jobId, batchJobIds);
                        resolve(batchJobIds);
                    });
                });
            });
            return promise;
        },

        /**
         * Update mongo job on successful job submission to AWS Batch.
         * returns no return. Batch job start is happening after response has been send to client
         */
        _updateJobOnSubmitSuccessful(jobId, batchIds) {
            c.crn.jobs.updateOne({_id: jobId}, {
                $set:{
                    'analysis.status': 'PENDING', //setting status to pending as soon as job submissions is successful
                    'analysis.attempts': 1,
                    'analysis.jobs': batchIds, // Should be an array of AWS ids for each AWS batch job
                    uploadSnapshotComplete: true
                }
            }, () => {
            //error handling???
            });
        },

        /**
         * Submit parallel jobs to AWS batch
         * for jobs with a subjectList parameter, we want to start all those jobs in parallel
         * submits all jobs in parallel and callsback with an array of the AWS batch ids for all the jobs
         */
        submitParallelJobs(batchJob, deps, callback) {
            let job = (params, callback) => {
                batch.submitJob(params, (err, data) => {
                    if(err) {callback(err);}
                    //pass the AWS batch job ID
                    let jobId = data.jobId;
                    callback(null, jobId);
                });
            };

            if (batchJob.parameters.hasOwnProperty('participant_label') &&
                batchJob.parameters.participant_label instanceof Array &&
                batchJob.parameters.participant_label.length > 0) {
                let jobs = [];
                console.log(batchJob.parameters.participant_label);
                batchJob.parameters.participant_label.forEach((subject) => {
                    let subjectBatchJob = JSON.parse(JSON.stringify(batchJob));
                    subjectBatchJob.dependsOn = _depsObjects(deps);
                    // Reduce participant_label to a single subject
                    subjectBatchJob.parameters.participant_label = [subject];
                    this._addJobArguments(subjectBatchJob);
                    delete subjectBatchJob.parameters;
                    jobs.push(job.bind(this, subjectBatchJob));
                });
                async.parallel(jobs, callback);
            } else {
                // Parallel job with no participants passed in
                let err = new Error('Parallel job submitted with no subjects specified');
                err.http_code = 422;
                callback(err);
            }
        },

        /**
         * Submits a single job to AWS Batch
         * for jobs without a subjectList parameter we are running all subjects in one job.
         * callsback with a single element array containing the AWS batch ID.
         */
        submitSingleJob(batchJob, deps, callback) {
            this._addJobArguments(batchJob);
            batchJob.dependsOn = _depsObjects(deps);
            // After constructing the job document, remove invalid object from batch job
            delete batchJob.parameters;
            batch.submitJob(batchJob, (err, data) => {
                if(err) {callback(err);}
                callback(null, [data.jobId]); //storing jobId's as array in mongo to support multi job analysis
            });
        },

        /**
         * Convert JSON parameters into a string to pass to the bids-app container
         *
         * Accepts an array of parameter objects
         * {key: ...value}
         */
        _prepareArguments(parameters) {
            return Object.keys(parameters).filter((key) => {
                // Skip empty arguments
                let value = parameters[key];
                if (value instanceof Array) {
                    return value.length > 0;
                } else {
                    return parameters[key];
                }
            }).map((key) => {
                let argument = '--' + key + ' ';
                let value = parameters[key];
                if (value instanceof Array) {
                    value = value.join(' ');
                }
                return argument.concat(value);
            }).join(' ');
        },

        /**
         * Convert batchJob.parameters to a BIDS_ARGUMENTS environment var
         * and add to document to submit the job
         */
        _addJobArguments(batchJob) {
            let env = batchJob.containerOverrides.environment;
            let bidsArguments = this._prepareArguments(batchJob.parameters);
            env.push({name: 'BIDS_ARGUMENTS', value: bidsArguments});
        },

        _validateInputs(jobDef) {
            let vcpusMax = config.aws.batch.vcpusMax;
            let memoryMax = config.aws.batch.memoryMax;

            if(jobDef.containerProperties.vcpus > vcpusMax || jobDef.containerProperties.memory > memoryMax) {
                return false;
            }

            return true;
        }
    };
};
