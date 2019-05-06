// https://developers.google.com/web/tools/puppeteer/articles/ssr

const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const httpProxy = require('http-proxy');

// weak promise wrappers for fs functions
// these are available in v10.0 but installing it is annoying
const mkdirRecursivePromise = (path) => (new Promise((resolve, reject) => (fs.mkdir(path, {recursive: true}, (err) => {
	if (err) {
		reject(err);
	} else {
		resolve();
	}
}))));
const readFilePromise = (path) => (new Promise((resolve, reject) => (fs.readFile(path, (err, data) => {
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

const makeListenToFreePort = (app, message, firstPort, doUnref) => {
	let ret = Promise.reject();
	for (let portOffset = 0; portOffset < 10; portOffset++) {
		const port = firstPort + portOffset;
		ret = ret.catch(() => new Promise((resolve, reject) => {
			const server = app.listen(port, () => {
				console.log(`${message} listening on http://localhost:${port}/`);
				resolve(port);
			});
			if (doUnref) {
				// unref'd servers will not prevent the node script from
				// terminating by virtue of running
				server.unref();
			}
			server.on('error', (e) => {
				console.log(e);
				reject(e);
			});
		}));
	}
	return ret;
};

const makeClientScript = (options) => `
Mavo.hooks.add("init-start", function (mavo) {
	// debugger;
	var ssrTemplate = document.getElementById("mv-ssr-template");
	if (ssrTemplate) {
		// var oldDisplay;
		var ssrRawNode = ssrTemplate.content.getElementById(mavo.id);
		if (ssrRawNode) {
			// console.log("cloning...");
			// var ssrCopy = ssrRawNode.cloneNode(true);
			// mavo.element.appendChild(ssrCopy);
			// oldDisplay = ssrCopy.style.display;
			// ssrCopy.style.display = "none";

			// console.log("transplanting...");
			mavo.element.classList.add("mv-ssr-init");
			mavo.ssrTarget = mavo.element;
			// mavo.element = ssrCopy;
			mavo.element = ssrRawNode;

			mavo.dataLoaded.then(function () {
				// console.log("mavo.dataLoaded happened; setting to oldDisplay: " + oldDisplay);
				console.log("mavo.dataLoaded happened");
				var finishTimeoutID, observer;
				var finish = function () {
					observer.disconnect();
					// finishTimeoutID = undefined;
					console.log("mavo ssr full loading done");
					// mavo.element.style.display = oldDisplay;
					mavo.element.classList.add("mv-ssr-done");
					mavo.ssrTarget.parentNode.replaceChild(mavo.element, mavo.ssrTarget);
				};
				finishTimeoutID = window.setTimeout(finish, ${options.pollTimeout});

				var callback = function(mutationsList, observer) {
					if (finishTimeoutID) {
						window.clearTimeout(finishTimeoutID);
						finishTimeoutID = window.setTimeout(finish, ${options.pollTimeout});
					}
				};

				observer = new MutationObserver(callback);
				observer.observe(mavo.element, {
					attributes: true,
					childList: true,
					subtree: true,
				});
			});
		}
	}
});
`;

const LAST_RESORT_TIMEOUT = 30 * 1000; // 30 seconds

async function ssr(url, options) {
	const start = Date.now();
	const browser = await puppeteer.launch({headless: options.headless});
	const page = await browser.newPage();

	// 1. Intercept network requests.
	await page.setRequestInterception(true);

	page.on('request', req => {
		// 2. Ignore requests for resources that don't produce DOM
		// (images, stylesheets, media).
		const whitelist = ['document', 'script', 'xhr', 'fetch'];
		if (!whitelist.includes(req.resourceType())) {
			return req.abort();
		}

		// 3. Pass through all other requests.
		req.continue();
	});

	// debugging
	page.on('console', msg => console.log('PAGE LOG:', msg.text()));
	page.on('error', msg => console.log('PAGE ERR:', msg.message));
	page.on('pageerror', msg => console.log('PAGE ERR:', msg.message));

	const lastResortTimeout = new Promise((resolve) => {
		setTimeout(() => resolve(), options.lastResortTimeout);
	});

	// There are some weird Promise contortions here.
	let mvLoadResolve;
	const mvLoadPromise = new Promise((resolve) => { mvLoadResolve = resolve; });
	// https://github.com/GoogleChrome/puppeteer/blob/master/examples/custom-event.js
	await page.exposeFunction('onMvLoad', async () => {
		mvLoadResolve(await page.content()); // serialized HTML of page DOM.
	});
	// We must wait for exposeFunction to finish before proceeding to
	// evaluateOnNewDocument below, since it calls the exposed function;
	// likewise, each of the subsequent method invocations on page must await
	// for the previous. On the other hand, we don't want to wrap all these
	// invocations in a promise that gets resolved the instant onMvLoad gets
	// called, because apparently this interrupts Puppeteer actions halfway
	// through and causes them to throw errors.
	await page.evaluateOnNewDocument((CLIENT_SCRIPT, options) => {
		let rawNodes = {};
		document.addEventListener("DOMContentLoaded", event => {
			self.Mavo.hooks.add("init-start", mavo => {
				const clone = mavo.element.cloneNode(true /*deep*/);
				rawNodes[mavo.id] = clone;
			});
		});
		let mvLoaded = false;
		document.addEventListener("mv-load", async (event) => {
			if (mvLoaded) return;
			mvLoaded = true;

			await Bliss.ready();
			await Mavo.inited;
			await Promise.all(Array.from(Mavo.all).map(mavo => mavo.dataLoaded.catch(e => e)));
			let observer;
			let finishTimeoutID;
			const finish = () => {
				observer.disconnect();
				// finishTimeoutID = undefined;
				for (let name in Mavo.all) {
					const element = Mavo.all[name].element;
					element.classList.add("mv-ssr-target");
					// don't prevent rehydration here by removing
					// mv-app attribute as that might mess with CSS
					// selectors

					// requires Mavo support for something like this
					element.classList.add("mv-no-hiding-during-loading");
				}
				const templateElement = document.createElement("template");
				templateElement.id = "mv-ssr-template";
				for (let rawId in rawNodes) {
					const rawNode = rawNodes[rawId];
					rawNode.id = rawId;
					templateElement.content.appendChild(rawNode);
				}
				document.head.appendChild(templateElement);

				if (options.colorDebug) {
					const clientStyleElement = document.createElement("style");
					clientStyleElement.textContent = `
					.mv-ssr-target * { color: red !important; }
					.mv-ssr-init * { color: yellow !important; }
					.mv-ssr-done * { color: green !important; }
					`;
					document.head.appendChild(clientStyleElement);
				}

				const clientScriptElement = document.createElement("script");
				clientScriptElement.text = CLIENT_SCRIPT;
				document.body.appendChild(clientScriptElement);

				window.onMvLoad();
			};
			finishTimeoutID = window.setTimeout(finish, 500);

			const callback = function(mutationsList, observer) {
				if (finishTimeoutID) {
					window.clearTimeout(finishTimeoutID);
					finishTimeoutID = window.setTimeout(finish, 500);
				}
			};

			observer = new MutationObserver(callback);
			for (let name in Mavo.all) {
				observer.observe(Mavo.all[name].element, {
					attributes: true,
					childList: true,
					subtree: true,
				});
			}
		});
	}, makeClientScript({pollTimeout: options.pollTimeout}), {colorDebug: options.colorDebug});
	await page.goto(url, {waitUntil: 'networkidle0'});
	const html = await Promise.race([mvLoadPromise, lastResortTimeout]);
	await browser.close();

	if (html === undefined) {
		console.info(`Headless timed out waiting for render!`);
		return undefined;
	} else {
		const ttRenderMs = Date.now() - start;
		console.info(`Headless rendered page in: ${ttRenderMs}ms`);

		return {html, ttRenderMs};
	}
}

const makeStaticAppAndGetPort = (path, staticPort) => {
	const staticApp = express();
	staticApp.use(express.static(path));
	const port = staticPort === undefined ? 8000 : staticPort;
	return makeListenToFreePort(staticApp, "static server", 8000, true);
};

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
};

require('yargs').command({
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
	handler: (argv) => {
		makeStaticAppAndGetPort(argv.path, argv.staticPort).then((staticPort) => {
			const app = express();

			const localServer = `http://localhost:${staticPort}/`;
			const apiProxy = httpProxy.createProxyServer();
			app.all("/dist/*", function(req, res) {
				console.log('passing through to server: ' + req.path);
				apiProxy.web(req, res, {target: localServer});
			});
			app.all("/*.(css|jpg|png|svg|js)", function(req, res) {
				console.log('passing through to server: ' + req.path);
				apiProxy.web(req, res, {target: localServer});
			});
			app.get('/(*(/|.html))?', async (req, res, next) => {
				let cacheFile = undefined;
				if (argv.cache !== undefined) {
					cacheFile = argv.cache + req.path + (req.path.endsWith('/') ? 'index.html' : '');
					const cachedContents = await readFilePromise(cacheFile, {encoding: 'utf-8'}).catch(() => undefined);
					if (cachedContents !== undefined) {
						return res.status(200).send(cachedContents); // Serve cached version.
					}
				}
				const ssrResult = await ssr(`${localServer}${req.path}`, {
					colorDebug: argv.colorDebug,
					headless: argv.headless,
					pollTimeout: argv.pollTimeout,
					lastResortTimeout: argv.lastResortTimeout,
				});
				if (ssrResult) {
					const {html, ttRenderMs} = ssrResult;
					if (cacheFile !== undefined) {
						console.log('writing to cache');
						await mkdirRecursivePromise(path.dirname(cacheFile));
						await writeFilePromise(cacheFile, html);
					}
					// Add Server-Timing! See https://w3c.github.io/server-timing/.
					res.set('Server-Timing', `Prerender;dur=${ttRenderMs};desc="Headless render time (ms)"`);
					return res.status(200).send(html); // Serve prerendered page as response.
				} else {
					return res.status(500).send('Error: server-side rendering Mavo page timed out!');
				}
			});

			makeListenToFreePort(app, "SSR server", argv.port);
		});
	},
}).command({
	command: "prerender <path-to-site> <url-path>",
	desc: "server-side render a Mavo page",
	builder: (yargs) => {
		addSSROptions(yargs);
	},
	handler: (argv) => {
		makeStaticAppAndGetPort(argv.pathToSite, argv.staticPort).then(async (staticPort) => {
			const localServer = `http://localhost:${staticPort}/`;
			const urlPath = argv.urlPath;
			const {html, ttRenderMs} = await ssr(`${localServer}${urlPath}`, {
				colorDebug: argv.colorDebug,
				headless: argv.headless,
				pollTimeout: argv.pollTimeout,
				lastResortTimeout: argv.lastResortTimeout,
			});
			const file = urlPath.replace(/[^-_.a-zA-Z0-9]/g, "_");
			await writeFilePromise(`./${file}`, html);
		});
	},
}).demandCommand().recommendCommands().strict().argv;
// we could make a server that prerenders as a service
//
// try mutationobserver? (see prerender.io tweet)
// / test multiple apps
// separate template tag per app?
// try last child
//...
// have a last-resort timeout
// use cases:
// 1. run this node server; prerender/cache on demand
// 2. prerender everything ahead of time
// can we run everything in the browser?
