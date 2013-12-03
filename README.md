John Kimble
===========

John Kimble is a Web system for live, anonymous classroom feedback.
Students load this page:

![Feedback screenshot](https://github.com/kohler/johnkimble/raw/master/doc/feedback-screenshot.png)

The “STOP” and “GO” buttons indicate confusion and boredom,
respectively; “ASK” lets a student ask a question. The instructor
loads another screen that visually summarizes the class.

![Feedback board screenshot](https://github.com/kohler/johnkimble/raw/master/doc/board-screenshot.png)

Installation
------------

Run like this:

    node johnkimble

This puts the server in the background, listening on port 6169. Run
`node johnkimble --fg` to run in the foreground. Logs are written to
`access.log` and `error.log`.

To test load these URLs:

    http://localhost:6169/test
    http://localhost:6169/test/board

The `test` portion of the URL is a class name. Different classes are
independent.

Configuration
-------------

The Javascript file `jkconfig.js` in the John Kimble directory can
be used for configuration. There are three configuration objects:
`server_config` for server-wide options, `course_config` for per-course
options, and `default_course_config` for default values for per-course
options. Call `extend` to change configuration options in one or more of
these objects. For instance, to run John Kimble on a different port and
a specific hostname, put this in `jkconfig.js`:

```js
extend(server_config, {
   host: "hostname", port: 8192
});
```

The `--init-file` option can specify a different configuration file to
load; for instance, `node johnkimble.js --init-file=FILE`.

### `server_config` options

* `host` (string, default: none)

    Server host name used for Ajax requests. If unset, requests will
    use relative URLs.

* `port` (integer, default: 6169)

    Server port number.

* `access_log` (string, default: `"access.log"`)

    Name of log file for recording accesses. John Kimble records
    accesses in an Apache-like format. For example:

    ```
    140.247.0.5 V8AGFQYC - [13/Nov/2012:17:37:04 -0500] "POST /cs61/login HTTP/1.1" 200 197
    140.247.0.5 j7QHFQEA - [13/Nov/2012:17:37:18 -0500] "GET /feedback/panel HTTP/1.1" 200 157
    ```

    The `V8AGFQYC` portion is a user ID.

    John Kimble does not rotate log files.

* `access_log_query` (boolean, default: true)

    If true, then the access log will report request parameters, such as
    the questions provided to “Ask”.

* `error_log` (string, default: `"error.log"`)

    Name of log file for recording errors.

* `hmac_key` (string, default: random bytes)

    Secret used for HMAC. John Kimble uses cookies to identify users.
    The cookies aren't currently encrypted, but they are
    authenticated, using SHA-256 HMAC and this key. If you set
    `server_config.hmac_key` to a stable value, then cookies from one
    server run can be accepted by a later server run.

* `proxy` (boolean, default: true)

    Check for common proxy headers. If the connection has no remote
    address, and `server_config.proxy` is true, then John Kimble will
    use any `X-Forwarded-For` header to determine the client's
    address. If `proxy` is a string, it should be a string or regular
    expression, such as `/^127\.0\.0\.1$/`; John Kimble will only use
    proxy headers when the remote host matches that address.

### Course configuration options

Course configuration options may be set in `default_course_config` or
in `course_config`. `default_course_config` sets the defaults for all
courses on the server. Override the defaults for a course named
`COURSE` using the `course_config[COURSE]` object. For example:

```js
// Courses handle up to 100 students each
extend(default_course_config, {
    capacity: 100
});
// ...except CS61 can handle 300
extend(course_config, {
    cs61: { capacity: 300 }
});
```

#### Overall configuration

* `title` (string)

    Human-readable name of course. Can contain HTML tags.

* `feedback_title` (string)

    Human-readable title for feedback pages. Can contain HTML tags.
    Defaults to `TITLE Feedback`, where `TITLE` is the `title`
    configuration option.

* `board_title` (string)

    Human-readable title for the feedback board. Can contain HTML
    tags. Defaults to `TITLE Feedback Board`, where `TITLE` is the
    `title` configuration option.

* `password` (string)

    Course password. Set this to enable “probation” (control- or
    shift-clicking on a location in the feedback board will put that
    student on probation and hide their questions and feedback for one
    minute). Only users who know the password can put students on
    probation.

#### Capacity options

* `capacity` (integer, default: 1000)

    Maximum number of students in the course. When more than
    `capacity` students attempt to log in, the system will kick out
    old students to keep the total number of students within
    `capacity`.

* `overload_capacity` (integer, default: 300)

    Number of students above which the course is in overload. See the
    Authentication section.

* `guarantee` (milliseconds, default: 30000 [30 seconds])

    New students are guaranteed to stay in the system for at least
    `guarantee` milliseconds.

* `lease` (milliseconds, default: 180000 [3 minutes])

    Lease for student feedback activity. The student feedback page
    will check back with the server at least every `lease`
    milliseconds. After `lease` milliseconds of inactivity, the
    student's indicator will disappear from the feedback board.

#### Feedback timing options

* `duration` (milliseconds, default: 180000 [3 minutes])

    Amount of time it takes feedback to fade away.

* `hold_duration` (milliseconds, default: 30000 [30 seconds])

    Amount of time feedback is shown at full strength (before it
    starts to fade away).

* `emphasis_duration` (milliseconds, default: 10000 [10 seconds])

    If students click a feedback button several times in a short
    interval, the feedback is *emphasized* by showing it as larger
    than normal. `emphasis_duration` determines how long it takes for
    this emphasis to dissipate.

#### Question options

* `question` (boolean, default: true)

    Determines whether students can ask questions. If true, an ASK
    button is shown on the feedback form.

* `question_capacity` (integer, default: 1000)

    Maximum number of questions the server will remember per course.
    If more than this number are asked, the server will forget the
    oldest ones.

* `question_guarantee` (milliseconds, default: 30000 [30 seconds])

    Amount of time a question is guaranteed to stay in the system.

* `bowdlerizer` (string, regular expression, or function)

    Used to sanitize questions before sending them to the feedback
    board. The default removes some English swears.

#### Authentication options

* `auth` (boolean or string, default: false)

    Whether to authenticate users.

    If `false` or `"never"`, then no authentication is performed:
    anyone can leave feedback, and there's no protection against
    scripts.

    If `true` or `"always"`, then all users are authenticated.

    If `"feedback"`, then users are authenticated before they leave
    feedback or ask a question.

    If `"overload"`, then users are authenticated when the system is
    under overload (more than `overload_capacity` students are logged
    in).

* `auth_method` (string, default: `"recaptcha"`)

    Authentication method. Currently only reCAPTCHA is supported. If
    you use reCAPTCHA, you must also set `recaptcha_public` and
    `recaptcha_private`.

* `recaptcha_public` (string)

    reCAPTCHA public key.

* `recaptcha_private` (string)

    reCAPTCHA private key.

* `auth_timeout` (milliseconds, default: 0)

    Amount of time after which authentication expires. If 0, then
    authentication never expires.

#### Feedback board options

John Kimble feedback boards use long polling so feedback shows up
instantaneously.

* `poll_capacity` (integer, default: 300)

    Maximum number of outstanding long polling requests allowed.

* `poll_timeout` (milliseconds, default: 30000 [30 seconds])

    Maximum length of time a long polling request may be outstanding.

#### Internal and debugging options

* `debug` (boolean, default: false)

    If true, then allow viewing internal system state and adding and
    removing "phantom" users.

* `jsontext` (boolean, default: true)

    If true, then JSON responses are sent with MIME type `text/plain`.
    Otherwise they are sent with type `text/json`.

* `require_post` (boolean, default: true)

    If false, then users can leave feedback or ask questions using
    HTTP GET requests. The default is to require POST.

* `hmac_key` (string, default: global `hmac_key` + course name)

    Secret used for HMAC for this course's cookies. See `hmac_key` above.


Eddie Kohler, ekohler@gmail.com
