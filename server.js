const express = require('express');
const fs = require('fs');
const path = require('path');
const httpProxy = require('http-proxy');
const ssr = require('./ssr');

// Simple promise wrappers for fs functions. (These are available in node v10,
// but installing it is annoying.)
const mkdirPromise = (path) => (new Promise((resolve, reject) => (fs.mkdir(path, {recursive: true}, (err) => {
	if (err) {
		reject(err);
	} else {
		resolve();
	}
}))));
const mkdirRecursivePromise = (p) => {
	return mkdirPromise(p).catch((err) => {
		if (err.code === 'ENOENT') {
			return mkdirRecursivePromise(path.dirname(p)).then(() => mkdirPromise(p));
		} else {
			// maybe the directory already exists
			fs.stat(p, (statErr, stat) => {
				if (statErr || !stat.isDirectory()) {
					// prefer mkdir error over stat error?
					return Promise.reject(err);
				}
			});
		}
	});
};
const readFilePromise = (path) => (new Promise((resolve, reject) => (fs.readFile(path, {encoding: 'utf-8'}, (err, data) => {
	if (err) {
		reject(err);
	} else {
		resolve(data);
	}
}))));
const writeFilePromise = (path, data) => (new Promise((resolve, reject) => (fs.writeFile(path, data, (err) => {
	if (err) {
		reject(err);
	} else {
		resolve();
	}
}))));

const addSSROptions = (yargs) => {
	yargs.option('static-port', {
		default: 8000,
		describe: "port to internally serve raw static files on",
		type: 'number',
	});
	yargs.option('color-debug', {
		describe: "inject a stylesheet to change the color",
		type: 'boolean',
	});
	yargs.option('headless', {
		default: true,
		describe: "don't display the browser used for server-side rendering (on by default, use --no-headless to disable)",
		type: 'boolean',
	});
	yargs.option('poll-timeout', {
		describe: "how long to wait without mutations to decide that rendering is finished, in milliseconds",
		default: 500,
		type: 'number',
	});
	yargs.option('last-resort-timeout', {
		describe: "how long to wait before aborting rendering, in milliseconds",
		default: 30000,
		type: 'number',
	});
	yargs.option('render-non-mavo', {
		describe: "render even pages that don't seem to have Mavo",
		type: 'boolean',
	});
	yargs.option('verbose', {
		describe: "print more things",
		type: 'boolean',
	});
};

require('yargs').strict().command({
	command: "serve <path>",
	desc: "statically serve a Mavo site",
	builder: (yargs) => {
		yargs.option('port', {
			default: 8080,
			describe: "port to serve on",
			type: 'number',
		});
		addSSROptions(yargs);
		yargs.option('cache', {
			describe: "path to a directory to cache repeated requests in",
			type: 'string',
		});
	},
	handler: async (argv) => {
		const staticPort = await ssr.makeStaticAppAndGetPort(argv.path, argv.staticPort);
		const app = express();

		const localServer = `http://localhost:${staticPort}/`;
		const apiProxy = httpProxy.createProxyServer();
		app.all("/dist/*", function(req, res) {
			if (argv.verbose) {
				console.log('passing through asset to server: ' + req.path);
			}
			apiProxy.web(req, res, {target: localServer});
		});
		app.all("/*.(css|jpg|png|svg|js)", function(req, res) {
			if (argv.verbose) {
				console.log('passing through asset to server: ' + req.path);
			}
			apiProxy.web(req, res, {target: localServer});
		});
		app.get('/(*(/|.html))?', async (req, res, next) => {
			let cacheFile = undefined;
			if (argv.cache !== undefined) {
				cacheFile = argv.cache + req.path + (req.path.endsWith('/') ? 'index.html' : '');
				const cachedContents = await readFilePromise(cacheFile, {encoding: 'utf-8'}).catch(() => undefined);
				if (cachedContents !== undefined) {
					console.log(`responding with cached version at ${cacheFile} (${cachedContents.length} chars)`);
					return res.status(200).send(cachedContents); // Serve cached version.
				}
			}
			const ssrResult = await ssr.render(`${localServer}${req.path}`, {
				colorDebug: argv.colorDebug,
				headless: argv.headless,
				pollTimeout: argv.pollTimeout,
				lastResortTimeout: argv.lastResortTimeout,
				renderNonMavo: argv.renderNonMavo,
				verbose: argv.verbose,
			});
			if (ssrResult) {
				const {content, ttRenderMs} = ssrResult;
				if (cacheFile !== undefined) {
					console.log(`caching version at ${cacheFile}`);
					await mkdirRecursivePromise(path.dirname(cacheFile));
					await writeFilePromise(cacheFile, content);
				}
				// Add Server-Timing! See https://w3c.github.io/server-timing/.
				res.set('Server-Timing', `Prerender;dur=${ttRenderMs};desc="Headless render time (ms)"`);
				return res.status(200).send(content); // Serve prerendered page as response.
			} else {
				return res.status(500).send('Error: server-side rendering Mavo page timed out!');
			}
		});

		ssr.makeListenToFreePort(app, "SSR server", argv.port);
	},
}).command({
	command: "prerender <path-to-site> <url-path>",
	desc: "server-side render a Mavo page",
	builder: (yargs) => {
		addSSROptions(yargs);
	},
	handler: async (argv) => {
		const {content, ttRenderMs} = await ssr.prerender(argv.pathToSite, argv.urlPath, argv);
		const file = argv.urlPath.replace(/[^-_.a-zA-Z0-9]/g, "_");
		await writeFilePromise(`./${file}`, content);
	},
}).demandCommand().recommendCommands().strict().argv;
