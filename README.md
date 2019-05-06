mavo-ssr
--------

Server-side rendering/prerendering for Mavo apps.

For Mavo apps that take a long time to load in the user's browser, this lets you do the loading on your computer or a server before the user sees it, letting them see the loaded content sooner. Note that the content the user sees initially will only be as new as when you do the preloading, and Mavo apps will likely still need the same amount of loading time to be interactive in the user's browser.

Install [Node](https://nodejs.org/) at least version 8 to use. Then, if your Mavo site is in the folder `/path/to/your/site`, you can run the simplest server like this:

```
$ node server.js /path/to/your/site
```

Then visit the SSR server that's printed in your browser.

You can pass in a directory that the server will cache renderings in with the option `--cache`.

Other settings are described if you run `node server.js`.
