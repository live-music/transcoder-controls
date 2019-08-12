const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, './.env') });
const psList = require('ps-list');
const fs = require('fs');
const Telnet = require('telnet-client');
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const bodyParser = require('body-parser');

const ENV = process.env;

const vaultOptions = {
  apiVersion: 'v1',
  endpoint: 'https://env.cue.dj:8200',
  token: fs.readFileSync(ENV.VAULT_TOKEN, 'utf8').trim()
};

const Vault = require('node-vault')(vaultOptions);

Vault.read('secret/env').then(vault => {
	const secrets = vault.data;
	const SERVICE_KEY = secrets.service_key;

	const app = express();
	app.use(cors());
	app.use(bodyParser.json());

	let TIME_TIL_RESET = 60000 * 60 * 3;
	let drainingStart;
	let draining = false;

	function verify(token, res, callback) {
		try {
				const verified = jwt.verify(token.jwt, SERVICE_KEY);
				return callback(verified);
		} catch (err) {
				return res.status(500).json('Authorization error');
		}
	}

	app.get('/health', (req, res) => {
		psList().then(data => {
			const info = data.find(process => {
				return (process.cmd === '/opt/transcoder-controls/liquidsoap /opt/transcoder-controls/transcoder.liq' && process.name === 'liquidsoap');
			});
		
			if (info) {
				res.json({ usage: info ? info.memory : null });
			} else {
				res.json({ error: 'LIQUIDSOAP_UNAVAILABLE' });
			}
		});
	});

	app.post('/start_liquidsoap', (req, res) => {
		verify(req.body, res, () => {
			psList().then(data => {
				const info = data.find(process => {
					return (process.cmd === '/opt/transcoder-controls/liquidsoap /opt/transcoder-controls/transcoder.liq' && process.name === 'liquidsoap');
				});

				if (info) {
					res.json({ error: 'LIQUIDSOAP_EXISTS' });
				} else {
					const { spawn } = require( 'child_process' );
					const start = spawn( '/opt/transcoder-controls/liquidsoap', [ '/opt/transcoder-controls/transcoder.liq' ] );
					start.stdout.on( 'data', data => {
						console.log( `stdout: ${data}` );
					} );

					start.stderr.on( 'data', data => {
						console.log( `stderr: ${data}` );
					} );

					start.on( 'close', code => {
						console.log( `child process exited with code ${code}` );
					} );
					res.json({ success: 'LIQUIDSOAP_STARTED' });
				}
			});
		});
	});

	function killLiquidsoap() {
		psList().then(data => {
			const info = data.find(process => {
				return (process.cmd === '/opt/transcoder-controls/liquidsoap /opt/transcoder-controls/transcoder.liq' && process.name === 'liquidsoap');
			});

			if (info) {
				const { spawn } = require( 'child_process' );
				const kill = spawn( 'kill', [ '-9', info.pid ] );
				kill.stdout.on('data', data => {
					console.log( `stdout: ${data}` );
				});

				kill.stderr.on('data', data => {
					console.log( `stderr: ${data}` );
				});

				kill.on('close', code => {
					console.log( `child process exited with code ${code}` );
				});

				drainingStart = null;
				draining = false;
			}
		});
	}

	function getTimeLeft() {
		if (drainingStart) {
			return (TIME_TIL_RESET - (Date.now() - drainingStart)) / 1000;
		} else {
			return '0';
		}
	}

	app.post('/stop_liquidsoap', (req, res) => {
		verify(req.body, res, (body) => {
			TIME_TIL_RESET = body.ttr;
			psList().then(data => {
				const info = data.find(process => {
					return (process.cmd === '/opt/transcoder-controls/liquidsoap /opt/transcoder-controls/transcoder.liq' && process.name === 'liquidsoap');
				});

				if (!info) {
					res.json({ error: 'LIQUIDSOAP UNAVAILABLE' });
				} else if (!draining) {
					drainingStart = Date.now();
					draining = setTimeout(() => {
						killLiquidsoap();
					}, TIME_TIL_RESET);
					res.json({ success: `DESTROYING IN ${ TIME_TIL_RESET } SECONDS` });
				} else {
					res.json({ success: `DESTROYING IN ${ getTimeLeft() } SECONDS` });
				}
			});
		});
	});

	app.post('/forcestop_liquidsoap', (req, res) => {
		verify(req.body, res, () => {
			killLiquidsoap();
			res.json({ success: `LIQUIDSOAP STOPPED` });
		});
	});

	app.get('/time_til_reset', (req, res) => {
		res.json({ success: `DESTROYING IN ${ getTimeLeft() } SECONDS` });
	});

	app.post('/start', (req, res) => {
		verify(req.body, res, (body) => {
			const connection = new Telnet();

			const params = {
					host: 'localhost',
					port: 1234,
					shellPrompt: '',
					negotiationMandatory: false,
					timeout: 1500,
			};

			connection.connect(params)
			.then(() => {
					connection.exec(`sources.add ${ body.stream.private}-${ body.stream.public }`)
					.then((response) => {
						res.json({ success: 'Transcoding started' });
					});
			}, (error) => {
				return res.status(409).json({ error });
			});
		});
	});

	app.post('/stop', (req, res) => {
		verify(req.body, res, (body) => {
			const connection = new Telnet();

			const params = {
					host: 'localhost',
					port: 1234,
					shellPrompt: '',
					negotiationMandatory: false,
					timeout: 1500,
			};

			connection.connect(params)
			.then(() => {
					connection.exec(`sources.remove ${ body.stream.public }`)
					.then((response) => {
						res.json('Transcoder stopped');
					});
			}, (error) => {
				return res.status(409).json({ error });
			});
		});
	});

	const server = http.createServer(app);
	server.listen(8080);
});