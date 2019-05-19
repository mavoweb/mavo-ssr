const express = require('express');
const puppeteer = require('puppeteer');

// Given an app and a port, try to make it listen to one of the first 10 ports
// after (including) the port number.
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

async function render(url, options) {
	const start = Date.now();
	const browser = await puppeteer.launch({headless: options.headless});
	const page = await browser.newPage();

	// Closely follows
	// https://developers.google.com/web/tools/puppeteer/articles/ssr
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

	if (options.verbose) {
		page.on('console', msg => console.log('PAGE LOG:', msg.text()));
	}
	page.on('error', msg => console.log('PAGE ERR:', msg.message));
	page.on('pageerror', msg => console.log('PAGE ERR:', msg.message));

	const lastResortTimeout = new Promise((resolve) => {
		setTimeout(() => resolve(), options.lastResortTimeout);
	});

	// There are some weird Promise contortions here.
	let mvLoadResolve;
	const mvLoadPromise = new Promise((resolve) => { mvLoadResolve = resolve; });
	// https://github.com/GoogleChrome/puppeteer/blob/master/examples/custom-event.js
	await page.exposeFunction('onMvLoad', async (hasMavo) => {
		mvLoadResolve({ content: await page.content(), hasMavo: hasMavo }); // serialized HTML of page DOM.
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
			if (self.Mavo) {
				self.Mavo.hooks.add("init-start", mavo => {
					const clone = mavo.element.cloneNode(true /*deep*/);
					rawNodes[mavo.id] = clone;
				});
			} else {
				window.onMvLoad(false);
			}
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

					// (requires Mavo support)
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

				window.onMvLoad(true);
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
	// as suggested by https://github.com/GoogleChrome/puppeteer/issues/749
	const response = await page.goto(url, {waitUntil: 'networkidle0'});
	const rawContent = await response.text();
	const loadResult = await Promise.race([mvLoadPromise, lastResortTimeout]);
	await browser.close();

	if (loadResult === undefined) {
		console.info(`Headless timed out waiting for render of page ${url}!`);
		return undefined;
	} else {
		const {content, hasMavo} = loadResult;
		const ttRenderMs = Date.now() - start;
		if (hasMavo || options.renderNonMavo) {
			console.info(`Headless rendered page ${url} (${hasMavo ? "with" : "without"} Mavo) to ${content.length} chars in ${ttRenderMs}ms`);

			return {content, hasMavo, ttRenderMs};
		} else {
			console.info(`Headless detected no Mavo; returned page ${url} with ${rawContent.length} chars in ${ttRenderMs}ms`);

			return {content: rawContent, hasMavo, ttRenderMs};
		}
	}
}

const makeStaticAppAndGetPort = (path, staticPort) => {
	const staticApp = express();
	staticApp.use(express.static(path));
	const port = staticPort === undefined ? 8000 : staticPort;
	return makeListenToFreePort(staticApp, "static server", 8000, true);
};

const prerender = async (pathToSite, urlPath, options) => {
	const staticPort = await makeStaticAppAndGetPort(pathToSite, options.staticPort);
	const localServer = `http://localhost:${staticPort}/`;
	return render(`${localServer}${urlPath}`, {
		colorDebug: options.colorDebug,
		headless: options.headless,
		pollTimeout: options.pollTimeout,
		lastResortTimeout: options.lastResortTimeout,
		renderNonMavo: options.renderNonMavo,
		verbose: options.verbose,
	});
};

exports.render = render;
exports.prerender = prerender;
exports.makeStaticAppAndGetPort = makeStaticAppAndGetPort;
exports.makeListenToFreePort = makeListenToFreePort;
