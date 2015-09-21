export default {
	port: 8765,
	headers: {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, PATCH, DELETE',
		'Access-Control-Allow-Headers': 'content-type'
	},
	scitran: {
		baseURL: 'https://scitran.sqm.io/api/',
		secret: 'a6c1f717eb4b438b80d6baa2866c2dc8',
	}
};