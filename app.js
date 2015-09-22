// dependencies ----------------------------------------------------

import express    from 'express';
import config     from './config';
import routes     from './routes';
import bodyParser from 'body-parser';
import morgan     from 'morgan';

// configuration ---------------------------------------------------

let app = express();

app.use((req, res, next) => {
    res.set(config.headers);
    res.type('application/json');
    next();
});
app.use(morgan('short'));
app.use(bodyParser.json());

// routing ---------------------------------------------------------

app.use('/api/v1/', routes);

// start server ----------------------------------------------------

app.listen(config.port, () => {
	console.log('Server is listening on port ' + config.port);
});