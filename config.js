export default {
	"port": 8765,
	"headers": {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, PATCH, DELETE",
		"Access-Control-Allow-Headers": "content-type, Authorization"
	},
	"scitran": {
		"url": "https://dev-openfmri.tacc.utexas.edu/api/",//"https://scitran.sqm.io/api/",
		"secret": "a6c1f717eb4b438b80d6baa2866c2dc8",
	},
	"agave": {
		"url": "https://api.tacc.utexas.edu/",
		"username": "crn_plab",
		"password": "Eid5Dreacmyt.necGien5",
		"clientName": "crn_plab",
		"clientDescription": "Agave client application for CRN interaction.",
		"consumerKey": "DzHquIQtPEId8mR_7PHIc_uSJzUa",
		"consumerSecret": "XYIXLbQc0fH6gBLIxwxdtx9UFj4a"
	},
	"mongo": {
		"url": "mongodb://localhost:27017/crn"
	}
};