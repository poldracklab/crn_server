export default {
	port: 8765,
	headers: {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, PATCH, DELETE',
		'Access-Control-Allow-Headers': 'content-type, Authorization'
	},
	scitran: {
		url: 'https://scitran.sqm.io/api/',
		secret: 'a6c1f717eb4b438b80d6baa2866c2dc8',
	},
	agave: {
		url: 'https://api.tacc.utexas.edu/',
		username: 'oesteban',
		password: 'a.long.SECURE.pass.for.Agave.2015',
		consumerKey: 'hDNOenVzCrzTr5EIwu3QkESm9fUa',
		consumerSecret: 'rYeS6jv9LQvdLMNhifgcrcNDlhka',
	},
	mongo: {
		url: 'mongodb://localhost:27017/crn'
	}
};