John Kimble
===========

John Kimble is a Web system for live, anonymous classroom feedback.
Students load a simple Web page that looks like this:

![Feedback screenshot](https://github.com/kohler/johnkimble/raw/master/doc/feedback-screenshot.png)

The “STOP” and “GO” buttons indicate confusion and boredom; the “ASK”
button lets a student ask a question. The instructor loads another
simple screen that visually summarizes the class.

![Feedback board screenshot](https://github.com/kohler/johnkimble/raw/master/doc/board-screenshot.png)

Installation
------------

Run like this:

    node server

This puts the server in the background, listening on port 6169. Run
`node server --fg` to run in the foreground. Logs are written to
`access.log` and `error.log`.

To test load these URLs:

    http://localhost:6169/test
    http://localhost:6169/test/board

The `test` portion of the URL is a class name. Different classes are
independent.

Configuration
-------------

Configure by writing a Javascript file `serverconfig.js` in the John
Kimble directory. For instance, to run John Kimble on a different port
and a specific hostname:

```js
extend(server_config, {
   host: "hostname", port: 8192
});
```

Eddie Kohler
