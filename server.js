// https://developers.google.com/web/tools/puppeteer/articles/ssr

const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const httpProxy = require('http-proxy');

const makeListenToFreePort = (app, message, firstPort, doUnref) => {
	let ret = Promise.reject();
	for (let portOffset = 0; portOffset < 10; portOffset++) {
		const port = firstPort + portOffset;
		ret = ret.catch(() => new Promise((resolve, reject) => {
			const server = app.listen(port, () => {
				console.log(message + " listening on port " + port);
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

const HEADLESS = true;
const COLOR_DEBUG = true;

const CLIENT_SCRIPT = `
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
				finishTimeoutID = window.setTimeout(finish, 500);

				var callback = function(mutationsList, observer) {
					if (finishTimeoutID) {
						window.clearTimeout(finishTimeoutID);
						finishTimeoutID = window.setTimeout(finish, 500);
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

async function ssr(url) {
	const start = Date.now();
	const browser = await puppeteer.launch({headless: HEADLESS});
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
	await page.evaluateOnNewDocument((CLIENT_SCRIPT, COLOR_DEBUG) => {
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
					element.classList.add("mv-no-loading");
				}
				const templateElement = document.createElement("template");
				templateElement.id = "mv-ssr-template";
				for (let rawId in rawNodes) {
					const rawNode = rawNodes[rawId];
					rawNode.id = rawId;
					templateElement.content.appendChild(rawNode);
				}
				document.head.appendChild(templateElement);

				if (COLOR_DEBUG) {
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
	}, CLIENT_SCRIPT, COLOR_DEBUG);
	await page.goto(url, {waitUntil: 'networkidle0'});
	const html = await mvLoadPromise;
	await browser.close();

	const ttRenderMs = Date.now() - start;
	console.info(`Headless rendered page in: ${ttRenderMs}ms`);

	return {html, ttRenderMs};
}

const makeStaticAppAndGetPort = (path) => {
	const staticApp = express();
	staticApp.use(express.static(path));
	return makeListenToFreePort(staticApp, "static server", 8000, true);
};

if (process.argv.length >= 4 && process.argv[2] === "server") {
	makeStaticAppAndGetPort(process.argv[3]).then((staticPort) => {
		const app = express();

		const localServer = `http://localhost:${staticPort}/`;
		app.get('/:page.html', async (req, res, next) => {
			const {html, ttRenderMs} = await ssr(`${localServer}${req.params.page}.html`);
			// Add Server-Timing! See https://w3c.github.io/server-timing/.
			res.set('Server-Timing', `Prerender;dur=${ttRenderMs};desc="Headless render time (ms)"`);
			return res.status(200).send(html); // Serve prerendered page as response.
		});
		app.get('/restaurants/', async (req, res, next) => {
			const {html, ttRenderMs} = await ssr(`${localServer}restaurants/`);
			// Add Server-Timing! See https://w3c.github.io/server-timing/.
			res.set('Server-Timing', `Prerender;dur=${ttRenderMs};desc="Headless render time (ms)"`);
			return res.status(200).send(html); // Serve prerendered page as response.
		});
		const apiProxy = httpProxy.createProxyServer();
		app.all("/dist/*", function(req, res) {
			console.log('passing through to server: ' + req.path);
			apiProxy.web(req, res, {target: localServer});
		});
		app.all("/*.(css|jpg|png|svg|js)", function(req, res) {
			console.log('passing through to server: ' + req.path);
			apiProxy.web(req, res, {target: localServer});
		});

		makeListenToFreePort(app, "SSR server", 8080);
	});
} else if (process.argv.length >= 5 && process.argv[2] === "prerender") {
	makeStaticAppAndGetPort(process.argv[3]).then(async (staticPort) => {
		const localServer = `http://localhost:${staticPort}/`;
		const path = process.argv[4];
		const {html, ttRenderMs} = await ssr(`${localServer}${path}`);
		const file = path.replace(/[^-_.a-zA-Z0-9]/g, "_");
		fs.writeFile(`./${file}`, html, (err) => {
			if (err) {
				reject(err);
			} else {
				resolve();
			}
		});
	});
} else {
	console.log("node server.js server <path to static root>");
	console.log("node server.js prerender <path to static root> <page>");
}

// we could make a server that prerenders as a service
//
// try mutationobserver? (see prerender.io tweet)
// / test multiple apps
// separate template tag per app?
// try last child
