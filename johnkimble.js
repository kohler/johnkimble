"use strict";

var http = require("http");
var url = require("url");
var cookies = require("cookies");
var querystring = require("querystring");
var fs = require("fs");
var crypto = require("crypto");
var util = require("util");
function extend(dst, src) {
    for (var i in src)
        dst[i] = src[i];
}

var server_config = {
    port: 6169,
    access_log: "access.log",
    error_log: "error.log",
    access_log_query: true,
    proxy: true
};
var default_course_config = {
    title: null,
    feedback_title: null,
    board_title: null,
    capacity: 1000,
    overload_capacity: 300,
    guarantee: 30000,
    lease: 180000,
    timeout: 720000,
    duration: 180000,
    hold_duration: 30000,
    emphasis_duration: 10000,
    gc_interval: 7200000,
    poll_timeout: 30000,
    poll_capacity: 300,
    question: true,
    question_capacity: 1000,
    question_guarantee: 30000,
    question_timeout: 300000,
    require_post: true,
    auth: false,
    auth_method: "recaptcha",
    jsontext: true,
    debug: false,
    phantom_feedback_types: [0, "ok", "stop"],
    bowdlerizer: "XGIoZnVja3xidWxsc2hpdHQ/fHNoaXR0P3xhc3Nob2xlfGZ1Y2tlcnxjdW50KSg/PXN8aW5nfFxiKQ=="
};
var course_config = {
};

var access_log = process.stdout;

if (!server_config.hmac_key)
    server_config.hmac_key = crypto.randomBytes(64);

var courses = {
    _size: 0
    // COURSENAME: { size: NSTUDENTS, polls: {...},
    //     s: { SCOOKIE: {
    //         id: SCOOKIE, ordinal: ordinal,
    //         at: timestamp, feedback: type,
    //         emphasis: count, feedback_at: timestamp } },
    //     os: [..students by ordinal..]
    // }
};

var server_id;
var cookie_re = new RegExp("^(.*?)&(.*)$");
var feedback_files = {
    "": "index.html",
    "index": "index.html",
    "index.html": "index.html",
    "board": "board.html",
    "board.html": "board.html",
    "jkfeedback.js": "jkfeedback.js",
    "feedback.js": "jkfeedback.js",
    "explosion.png": "explosion.png",
    "jquery-1.8.2.min.js": "jquery-1.12.4.min.js",
    "jquery-1.9.0.min.js": "jquery-1.12.4.min.js",
    "jquery-1.10.2.min.js": "jquery-1.12.4.min.js",
    "jquery-1.10.2.min.map": "jquery-1.12.4.min.map",
    "jquery-1.11.1.min.js": "jquery-1.12.4.min.js",
    "jquery-1.11.1.min.map": "jquery-1.12.4.min.map",
    "jquery-1.12.3.min.js": "jquery-1.12.4.min.js",
    "jquery-1.12.3.min.map": "jquery-1.12.4.min.map",
    "jquery-1.12.4.min.js": "jquery-1.12.4.min.js",
    "jquery-1.12.4.min.map": "jquery-1.12.4.min.map",
    "jquery.color-2.1.0.min.js": "jquery.color.plus-names-2.1.2.min.js",
    "jquery.color-2.1.1.min.js": "jquery.color.plus-names-2.1.2.min.js",
    "jquery.color-2.1.2.min.js": "jquery.color.plus-names-2.1.2.min.js",
    "jquery.color.plus-names-2.1.2.min.js": "jquery.color.plus-names-2.1.2.min.js"
};
var file_cache = {
};


// HELPER FUNCTIONS

// Return current time as an integer number of milliseconds
function get_now() {
    return (new Date).getTime();
}

// Receive a body sent onto `req`. When complete, parse it into `u.body`
// as a query string, then call `complete()`. If `query_index` is
// supplied, then a nonempty `u.query[query_index]` will skip body
// parsing, set `u.body = u.query`, and call `complete()` right away.
function http_read_body_form(u, req, complete, query_index) {
    if (query_index != null && u.query[query_index] != null) {
        u.body = u.query;
        return complete();
    }
    u.body = "";
    req.setEncoding("utf8");
    req.on("data", function (chunk) {
        u.body += chunk;
    }).on("end", function () {
        u.body = querystring.parse(u.body);
        complete();
    });
}

// Return the next user ID (a base64 string).
var next_id;
function make_next_id() {
    var id_buf = new Buffer(256), id_len = 6;
    id_buf.fill(0);
    id_buf.writeUInt32LE(server_id & 0x7FFFFFFF, 0);
    next_id = function () {
        var i = 4;
        do {
            ++id_buf[i], ++i;
            if (id_buf[i - 1] == 0 && i == id_len)
                id_len += 3;
        } while (id_buf[i - 1] == 0);
        return id_buf.toString("base64", 0, id_len);
    };
}


// LOGGING AND RESPONSES

function log_date_format(now) {
    var d = new Date(now), i, tzo = d.getTimezoneOffset(), atzo = Math.abs(tzo),
        x = [d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(),
             Math.floor(atzo / 60), atzo % 60];
    for (i = 0; i < 6; ++i)
        if (x[i] < 10)
            x[i] = "0" + x[i];
    i = x[0] + "/" +
        "JanFebMarAprMayJunJulAugSepOctNovDec".substr(d.getMonth() * 3, 3) +
        "/" + (d.getYear() + 1900) + ":" + x[1] + ":" + x[2] + ":" + x[3];
    if (atzo)
        i += (atzo < 0 ? " +" : " -") + x[4] + x[5];
    return i;
}

function log_access(u, req, path, res, data) {
    access_log.write(util.format("%s %s - [%s] \"%s %s%s\" %d %s \"%s\"\n",
                                 u.remoteAddress,
                                 u.cookie ? u.cookie.id : "-",
                                 log_date_format(u.now),
                                 req.method,
                                 path,
                                 req.httpVersion ? " HTTP/" + req.httpVersion : "",
                                 res.statusCode,
                                 data ? data.length : "-",
                                 req.headers["user-agent"] || ""));
}

function end_and_log(u, req, res, data) {
    var path = u.pathname, parts, t;
    if (server_config.access_log_query) {
        parts = [];
        if (u.query && (t = querystring.stringify(u.query)))
            parts.push(t);
        if (u.body && u.body != u.query && (t = querystring.stringify(u.body)))
            parts.push(t);
        if (parts.length)
            path += "?" + parts.join("&");
    }
    res.end(data);
    log_access(u, req, path, res, data);
}

function json_response(u, req, res, j) {
    var c = (u && u.course && courses[u.course]) || default_course_config;
    var content_type;
    if (u.query.callback)
        content_type = "application/javascript";
    else if ("jsontext" in u.query ? u.query.jsontext : c.jsontext)
        content_type = "text/plain";
    else
        content_type = "application/json";

    j = JSON.stringify(j);
    if (u.query.callback)
        j = u.query.callback + "(" + j + ")";

    res.writeHead(200, {
        "Content-Type": content_type,
        "Content-Length": Buffer.byteLength(j),
        "Access-Control-Allow-Origin": req.headers.origin || "*",
        "Access-Control-Allow-Credentials": true,
        "Access-Control-Allow-Headers": "Accept-Encoding"
    });
    end_and_log(u, req, res, j);
}

function redirect(where, u, req, res) {
    var m = "Redirecting\n";
    if (where[0] == "/")
        where = where.substr(1);
    res.writeHead(302, {
        "Location": "/" + u.course + "/" + where,
        "Content-Length": m.length,
        "Access-Control-Allow-Origin": req.headers.origin || "*",
        "Access-Control-Allow-Credentials": true,
        "Access-Control-Allow-Headers": "Accept-Encoding"
    });
    end_and_log(u, req, res, m);
}

function not_found(u, req, res) {
    res.writeHead(404);
    end_and_log(u, req, res, "File not found\n");
}


// COURSE OBJECT

function Course(name) {
    var i, f;
    this.name = name;
    this.s = {};
    this.os = [];
    this.qs = [];
    this.phanta = [];
    this.free_ordinals = [];
    this.size = 0;
    this.last_gc = this.last_forced_gc = this.updated_at = get_now();
    this.update = false;
    this.pollers = {};
    this.next_poller = 1;
    this.npollers = 0;
    this.hmac_key = server_config.hmac_key + name;
    this.file_cache = {};
    this.panel_auth = {};
    for (i in default_course_config)
        this[i] = default_course_config[i];
    for (i in course_config[name] || {})
        this[i] = course_config[name][i];

    if (!this.url && server_config.url)
        this.url = server_config.url;
    else if (!this.url)
        this.url = (this.https ? "https://" : "http://") +
            (server_config.host || "localhost") +
            (server_config.port == (this.https ? 443 : 80) ? "" : ":" + server_config.port) +
            (server_config.path || "");
    if (this.url && !this.url.match(/\/$/))
        this.url += "/";
    this.urlpath = "/";
    if ((i = this.url.match(/^(?:(?:https?:)?\/\/[^\/]+)(\/.*\/$)/))
        || (i = this.url.match(/^(\/.*\/)$/)))
        this.urlpath = i[1];

    if (typeof this.cookie_httponly === "undefined")
        this.cookie_httponly = true;
    if (this.auth == "never")
        this.auth = false;
    else if (this.auth && this.auth != "feedback" && this.auth != "overload")
        this.auth = true;
    if (!(this.auth_method == "recaptcha" && this.auth
          && this.recaptcha_public && this.recaptcha_private))
        this.auth = this.auth_method = false;
    if (typeof this.bowdlerizer === "string") {
        if (/^[A-Za-z0-9+\/=\s]+$/.test(this.bowdlerizer))
            this.bowdlerizer = new Buffer(this.bowdlerizer, "base64").toString();
        this.bowdlerizer = new RegExp(this.bowdlerizer, "gi");
    }
    if (this.bowdlerizer && this.bowdlerizer instanceof RegExp)
        this.bowdlerizer = make_bowdlerizer(this.bowdlerizer);
    if (!this.bowdlerizer || typeof this.bowdlerizer !== "function")
        this.bowdlerizer = function (s) { return s; };
}

function make_bowdlerizer(re) {
    return function (s) {
        return s.replace(re, "@#%!");
    };
}


// COOKIES

Course.prototype.check_cookie = function(req, res, now) {
    var c = new cookies(req, res), m, s, message_data, digest;
    try {
        if (!(m = c.get("feedback61"))
            || !(m = m.match(cookie_re)))
            return false;
        digest = crypto.createHmac("SHA256", this.hmac_key);
        digest.update(m[1], "utf8");
        if (digest.digest("base64") != m[2])
            return false;
        message_data = new Buffer(m[1], "base64").toString();
        m = JSON.parse(message_data);
        if (!m.id || m.n != this.name)
            return false;
        if (m.s != server_id) {
            // revivify user
            if ((s = this.ensure_user(m.id, now))) {
                if (m.a)
                    this.activate(s, now, m.a);
                this.set_cookie(s, req, res);
            } else
                return false;
        }
        return m;
    } catch (m) {
        return false;
    }
};

Course.prototype.set_cookie = function(s, req, res) {
    var j, jbuf, len, s, digest;
    j = {s: server_id, id: s.id, n: this.name};
    if (s.auth_at)
        j.a = s.auth_at;
    jbuf = new Buffer(256);
    len = jbuf.write(JSON.stringify(j));
    s = jbuf.toString("base64", 0, len);
    digest = crypto.createHmac("SHA256", this.hmac_key);
    digest.update(s, "utf8");
    s += "&" + digest.digest("base64");
    (new cookies(req, res)).set("feedback61", s, {
        path: this.urlpath + this.name + "/",
        httpOnly: this.cookie_httponly
    });
    return j;
};

Course.prototype.clear_cookie = function(req, res, now) {
    (new cookies(req, res)).set("feedback61", "", {
        path: "/" + this.name + "/",
        httpOnly: this.cookie_httponly,
        expires: new Date(now - 1000000)
    });
};


// USERS

Course.prototype.ensure_user = function(id, now) {
    var s = this.s[id];
    if (!s && this.size == this.capacity && this.last_forced_gc < now - 1000)
        this.gc(now, 1);
    if (!s && this.size != this.capacity) {
        this.s[id] = s = {
            id: id, at: 0, auth_at: 0,
            feedback: 0, emphasis: 0, feedback_at: 0
        };
        ++this.size;
    }
    return s;
};

Course.prototype.activate = function(s, now, auth_at) {
    var delta = now - s.at, o = s.ordinal;
    s.at = now;
    if (o != null && this.os[o] == s && delta < this.lease
        && (!auth_at || s.auth_at == auth_at))
        return;
    if (auth_at)
        s.auth_at = auth_at;
    if (o == null || this.os[o] != s) {
        if (this.free_ordinals.length)
            o = this.free_ordinals.shift();
        if (o == null || this.os[o])
            o = this.os.length;
    }
    s.ordinal = o;
    this.os[o] = s;
    this.update = true;
};

Course.prototype.deactivate = function(s, now) {
    if (s.ordinal != null && this.os[s.ordinal] == s) {
        this.free_ordinals.push(s.ordinal);
        this.os[s.ordinal] = null;
        while (this.os.length && !this.os[this.os.length - 1])
            this.os.pop();
        this.update = true;
    }
};

Course.prototype.gc = function(now, force_slots) {
    var i, j, ss = [];
    force_slots = force_slots || 0;
    for (i in this.s)
        ss.push(this.s[i]);
    if (ss.length != this.size)
        console.warn("[%s] %s.size == %d, contains %d",
                     log_date_format(now), this.name, this.size, ss.length);
    ss.sort(function (a, b) {
        if (!a.auth_at != !b.auth_at)
            return !!a.auth_at - !!b.auth_at;
        else
            return a.at - b.at;
    });

    var guarantee = now - this.guarantee,
        lease = now - this.lease,
        timeout = now - this.timeout;
    for (i = 0; i < ss.length
         && (!ss[i].at
             || ss[i].at < timeout
             || (ss.length - i + force_slots > this.capacity
                 && (ss[i].at < guarantee || !ss[i].auth_at)));
         ++i) {
        delete this.s[ss[i].id];
        --this.size;
        this.update = true;
    }
    for (j = 0; j < i || (j < ss.length && ss[j].at < lease); ++j)
        this.deactivate(ss[j], now);
    if (j > 0 && this.free_ordinals.length > 3 * this.size) {
        this.free_ordinals = [];
        this.os = ss.slice(j);
        for (j = 0; j < this.os.length; ++j)
            this.os[j].ordinal = j;
    }

    timeout = now - this.question_timeout;
    while (this.qs.length && this.qs[0][1] < timeout)
        this.qs.shift();

    this.last_gc = now;
    if (force_slots)
        this.last_forced_gc = now;
};


// AUTHENTICATION

Course.prototype.need_auth = function(action, auth_at, now) {
    return ((!auth_at
             || (this.auth_timeout && auth_at < now - this.auth_timeout))
            && (this.auth === true
                || (action != "login" && this.auth == "feedback")
                || (this.size > this.overload_capacity && this.auth == "overload")));
};

Course.prototype.auth_json_response = function(u, req, res) {
    return json_response(u, req, res, {
        auth: this.auth_method, recaptcha_public: this.recaptcha_public
    });
};

function make_auth_responder(course, u, req, res) {
    return function(j) {
        if (!j)
            j = {
                error: "reCAPTCHA access problem",
                recaptcha_error: "recaptcha-not-reachable"
            };
        if (j.error) {
            j.auth = course.auth_method;
            j.recaptcha_public = course.recaptcha_public;
        }
        if (u.query.ajax)
            return json_response(u, req, res, j);
        else
            return redirect("", u, req, res);
    };
}

Course.prototype.handle_auth = function(u, req, res) {
    var self = this, challenge, response, callback = make_auth_responder(self, u, req, res);
    if (this.auth_method != "recaptcha")
        return callback({
            ok: true, message: "authentication not required"
        });

    http_read_body_form(u, req, function() {
        if (!(challenge = u.body.recaptcha_challenge_field)
            || !(response = u.body.recaptcha_response_field))
            return callback({
                error: "reCAPTCHA response missing",
                recaptcha_error: "incorrect-captcha-sol"
            });

        var answer = "";
        function recaptcha_response(error) {
            var m, s;
            if (error && error.message)
                return callback({
                    error: error.message,
                    recaptcha_error: "recaptcha-not-reachable"
                });
            else if ((m = answer.split(/\n/)) && m.length >= 1 && m[0] == "true") {
                u.now = get_now();
                if ((s = self.ensure_user(u.cookie.id, u.now))) {
                    self.activate(s, u.now, u.now);
                    self.set_cookie(s, req, res);
                    return callback({ok: true});
                } else
                    return callback({error: "course full"});
            } else if (m.length >= 2 && m[0] == "false")
                return callback({error: "reCAPTCHA problem", recaptcha_error: m[1]});
            else
                return callback();
        }

        var recaptcha_req = http.request({
            host: "www.google.com",
            path: "/recaptcha/api/verify",
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded"
            }
        }, function (res) {
            res.setEncoding("utf8");
            res.on("data", function (chunk) { answer += chunk; });
            res.on("end", recaptcha_response);
        }).on("error", function () {
            return callback();
        });
        recaptcha_req.write(querystring.stringify({
            privatekey: self.recaptcha_private,
            remoteip: u.remoteAddress,
            challenge: challenge,
            response: response
        }));
        recaptcha_req.end();
    });
};


// STATUS RESULT

Course.prototype.status = function(s, u, req, res, extra) {
    var duration = this.duration, j = {
        hold_duration: this.hold_duration,
        duration: duration,
        emphasis_duration: this.emphasis_duration,
        lease: this.lease,
        ask: this.question_capacity > 0 && this.question,
        now: u.now,
        size: this.size
    };
    s = s || (u.cookie && this.s[u.cookie.id]);
    if (s) {
        j.id = s.id;
        j.feedback = s.feedback;
        j.emphasis = s.emphasis;
        j.feedback_at = s.feedback_at;
        if (s.q_at && u.now - s.q_at <= duration)
            j.question_at = s.q_at;
        if (s.probation_until && s.probation_until > u.now)
            j.probation_until = s.probation_until;
    }
    for (var i in extra || {})
        j[i] = extra[i];
    return json_response(u, req, res, j);
};


// PANEL

function enqueue_poller(course, u, req, res) {
    var timeout, poller;
    function f(arg) {
        if (arg) {
            clearTimeout(timeout);
            u.now = arg;
        } else {
            u.now = get_now();
            delete course.pollers[poller];
            --course.npollers;
        }
        timeout = null;
        course.panel(u, req, res, false);
    }

    timeout = setTimeout(f, course.poll_timeout, 0);
    if (course.npollers == course.poll_capacity)
        f(u.now);
    else {
        poller = course.next_poller;
        ++course.next_poller;
        ++course.npollers;
        while (course.pollers[poller])
            poller = (poller + 1) % 32768;
        course.pollers[poller] = f;
        res.on("close", function () {
            if (timeout) {
                clearTimeout(timeout);
                delete course.pollers[poller];
                --course.npollers;
            }
        });
    }
}

Course.prototype.panel = function(u, req, res, allow_queue) {
    var now = u.now;
    if (this.last_gc < now - this.gc_interval)
        this.gc(now, 0);
    var poll_at = u.query.poll;
    poll_at = +((poll_at && poll_at !== "true" && poll_at) || 0);
    if (poll_at >= this.updated_at && allow_queue)
        return enqueue_poller(this, u, req, res);

    var j = {
        now: now,
        updated_at: this.updated_at,
        hold_duration: this.hold_duration,
        duration: this.duration,
        emphasis_duration: this.emphasis_duration,
        size: this.size,
        nordinal: this.os.length,
        s: {},
        nfeedback: {}
    };
    if (u.cookie && this.panel_auth[u.cookie.id])
        j.panel_auth = true;

    var timeout = now - this.duration, lease = now - this.lease, i, s, jx, f;
    for (i = 0; i < this.os.length; ++i) {
        s = this.os[i];
        if (!s || s.at < lease)
            continue;

        jx = {};
        if (s.probation_until && s.probation_until > now)
            jx.probation_until = s.probation_until;
        if (((s.feedback && s.feedback_at >= timeout) || s.style)
            && !jx.probation_until) {
            jx.feedback = s.feedback;
            jx.feedback_at = s.feedback_at;
            jx.emphasis = s.emphasis;
            if (s.style)
                jx.style = s.style;
        }
        j.s[i] = jx;

        f = jx.feedback || 0;
        j.nfeedback[f] = (j.nfeedback[f] || 0) + 1;
    }

    if (this.qs.length && this.question) {
        var qs = this.qs;
        for (i = qs.length; i > 0 && qs[i-1][1] > poll_at; --i)
            /* do nothing */;
        for (; i < qs.length; ++i)
            if ((s = this.s[qs[i][0]]) && s.at >= lease) {
                j.qs = j.qs || [];
                j.qs.push([s.ordinal, qs[i][1], this.bowdlerizer(qs[i][2])]);
            }
    }

    return json_response(u, req, res, j);
};

function probation_auth_response(u, req, res, password_failed) {
    var j = {panel_auth: true, error: (password_failed ? "bad password" : "need course password")};
    if (password_failed)
        j.panel_auth_fail = true;
    if (typeof(u.body.s) == "string")
        j.s = u.body.s;
    return json_response(u, req, res, j);
}

Course.prototype.probation = function(s, now) {
    var i, qs;
    s.feedback = 0;
    s.feedback_at = now;
    if (!s.probation_until || s.probation_until + 3600000 <= now)
        s.probation_count = 0;
    else
        ++s.probation_count;
    s.probation_until = now + 60000 * Math.pow(2, s.probation_count);
    qs = this.qs;
    for (i = 0; i < qs.length; ++i)
        if (qs[i][0] == s.id) {
            qs.splice(i, 1);
            --i;
        }
    this.finish_update(now);
};

Course.prototype.probation_request = function(u, req, res) {
    var self = this;
    function complete() {
        var j, i, qs, s;
        if (u.cookie && typeof(u.body.password) == "string") {
            if (u.body.password == self.password)
                self.panel_auth[u.cookie.id] = true; // should expire this
            else
                return probation_auth_response(u, req, res, true);
        }
        if (!u.cookie || !self.panel_auth[u.cookie.id])
            probation_auth_response(u, req, res, false);
        else if (typeof(u.body.s) == "string" && (s = self.os[u.body.s])) {
            self.probation(s, u.now);
            json_response(u, req, res, {ok: true, probation_time: 60000});
        } else
            json_response(u, req, res, {error: "no such student"});
    }
    http_read_body_form(u, req, complete, "s");
};


// ACTIONS

Course.prototype.feedback = function(s, f, now) {
    if (f == "" || f == "cancel" || f == "0")
        f = 0;
    if (f && s.feedback == f)
        s.emphasis = 1 + s.emphasis * (1 - Math.min(1, (now - s.feedback_at) / this.emphasis_duration));
    else
        s.emphasis = f ? 1 : 0;
    s.feedback = f;
    s.at = s.feedback_at = now;
    if (s.q_at && now - s.q_at <= this.duration && !f) {
        delete s.q_at;
        this.qs.push([s.id, Math.max(this.updated_at + 1, now), ""]);
    }
    if (!s.probation_until || s.probation_until <= now)
        this.update = true;
};

function gc_questions(qs, timeout) {
    var capacity = qs.length;
    while (qs.length && qs[0][1] < timeout)
        qs.shift();
    if (qs.length != capacity)
        return;

    var count_by_id = {}, i, sid, num_ids = 0, num_per_id;
    for (i = 0; i < qs.length; ++i) {
        sid = qs[i][0];
        num_ids += !count_by_id[sid];
        count_by_id[sid] = (count_by_id[sid] || 0) + 1;
    }
    var new_capacity = capacity * 0.75;
    num_per_id = new_capacity / num_ids;
    for (i = 0; i < qs.length && qs.length > new_capacity; ++i) {
        sid = qs[i][0];
        if (count_by_id[sid] > num_per_id) {
            qs.splice(i, 1);
            --count_by_id[sid];
            --i;
        }
    }
    while (qs.length > new_capacity)
        qs.shift();
}

Course.prototype.ask_question = function(s, question, now) {
    var qs = this.qs, m;
    if (qs.length == this.question_capacity)
        gc_questions(qs, now - this.question_timeout);
    if (question.charAt(0) == "{"
        && (m = question.match(/^\{\s*style\b\s*(.*?)\}(.*)/i))) {
        s.style = m[1];
        question = m[2];
    }
    qs.push([s.id, Math.max(this.updated_at + 1, now), question]);
    s.at = s.q_at = now;
    if (!s.probation_until || s.probation_until <= now)
        this.update = true;
};

Course.prototype.ask_request = function(s, u, req, res) {
    var self = this;
    function complete() {
        u.now = u.now || get_now();
        if (typeof(u.body.q) == "string" && u.body.q.trim() != "") {
            self.ask_question(s, u.body.q.trim(), u.now)
            self.status(s, u, req, res);
        } else
            json_response(u, req, res, {error: "no question"});
        if (self.update)
            self.finish_update(u.now);
    }
    http_read_body_form(u, req, complete, "q");
};

Course.prototype.finish_update = function(now) {
    this.updated_at = Math.max(this.updated_at + 1, now);
    this.update = false;
    for (var i in this.pollers)
        this.pollers[i](now);
    this.pollers = {};
    this.npollers = 0;
};

Course.prototype.add_phantom = function(now) {
    var s = this.ensure_user(next_id(), now), self = this,
        changeability = 0.05 + Math.random() / 6;
    s.phantom = true;
    this.phanta.push(s);
    this.activate(s, now, false);
    function phantom() {
        var f, i, now = get_now();
        if (s.phantom !== true)
            return;
        self.activate(s, now);
        if (Math.random() < changeability) {
            f = self.phantom_feedback_types;
            self.feedback(s, f[Math.floor(Math.random() * f.length)], now);
        }
        if (self.update)
            self.finish_update(now);
        setTimeout(phantom, Math.min(3000 + Math.random() * self.hold_duration,
                                     Math.max(self.lease - 2000, 5000)));
    }
    setTimeout(phantom, 3000 + Math.random() * self.hold_duration);
};

Course.prototype.rm_phantom = function(now) {
    if (this.phanta.length == 0)
        return false;
    var i = Math.floor(Math.random() * this.phanta.length);
    this.phanta[i].phantom = "dead";
    this.phanta.splice(i, 1);
    return true;
};


// SERVER

function create_course(cname) {
    if (!courses[cname] && !course_config[cname] && courses._size > 10000)
        return false;
    courses[cname] = new Course(cname);
    ++courses._size;
    return true;
}

function FileCache(filename, content_type, translator) {
    this.filename = filename;
    this.content_type = content_type;
    this.data = null;
    this.translator = translator || (function (req, data) { return data; });
    this.callbacks = [];
}

(function () {
function fc_postread(fc, stat) {
    return function (err, data) {
        fc.data = fc.translator.call(fc, null, data);
        fc.stat = stat;
        fc.gzip = fc.deflate = null;
        var cbs = fc.callbacks;
        fc.callbacks = [];
        for (var i = 0; i < cbs.length; ++i)
            cbs[i].call(fc, fc.data);
    };
}


function fc_read(fc, cb) {
    if (fc.callbacks.length)
        fc.callbacks.push(cb);
    else {
        var stat = fs.statSync(fc.filename), data;
        if (fc.data && stat.ino == fc.stat.ino
            && stat.mtime.getTime() == fc.stat.mtime.getTime())
            cb.call(fc, fc.data);
        else {
            fc.callbacks.push(cb);
            var encoding = fc.is_binary() ? null : "utf8";
            fs.readFile(fc.filename, encoding, fc_postread(fc, stat));
        }
    }
}

FileCache.prototype.is_binary = function () {
    return this.content_type != "application/javascript" &&
        this.content_type != "text/html";
};

FileCache.prototype.read = function (cb) {
    fc_read(this, cb);
};

FileCache.prototype.compress = function (encoding, req, cb) {
    var fc = this, zlib, data;
    if (this[encoding] || !this.data)
        cb.call(this, this[encoding] || "");
    else {
        zlib = require("zlib");
        data = this.data;
        if (this.translator.live)
            data = this.translator.call(this, req, data);
        zlib[encoding](data, function (err, data) {
            if (!fc.translator.live)
                fc[encoding] = data;
            cb.call(fc, data);
        });
    }
};

function make_compress_cb(encoding, u, req, res) {
    return function (data) {
        this.compress(encoding, req, function (data) {
            res.writeHead(200, {
                "Content-Type": this.content_type,
                "Content-Length": data.length,
                "Content-Encoding": encoding
            });
            end_and_log(u, req, res, data);
        });
    };
}

function make_send_cb(u, req, res) {
    var enclist = req.headers["accept-encoding"] || "";
    if (enclist) {
        var re = /\b(gzip|deflate|identity)\s*(?:;\s*q\s*=\s*([\d.]+))?/g,
            encoding = "identity", q = 0.0001, m;
        while ((m = re.exec(enclist)))
            if (m[1] == encoding || +(m[2] || 1) > q) {
                encoding = m[1];
                q = +(m[2] || 1);
            }
        if (encoding != "identity")
            return make_compress_cb(encoding, u, req, res);
        else if (q == 0) {
            res.writeHead(406);
            return end_and_log(u, req, res, "Encoding not acceptable\n");
        }
    }
    return function (data) {
        if (this.translator.live)
            data = this.translator.call(this, req, data);
        res.writeHead(200, {
            "Content-Type": this.content_type,
            "Content-Length": Buffer.byteLength(data)
        });
        end_and_log(u, req, res, data);
    };
}

FileCache.prototype.send = function(u, req, res) {
    this.read(make_send_cb(u, req, res));
};

})();

function make_course_translator(course) {
    var f = function (req, data) {
        var x;
        if (!req) {
            x = course.board_title || (course.title && (course.title + " Feedback Board"));
            if (x)
                data = data.replace(/John Kimble Feedback Board/g, x);
            x = course.feedback_title || (course.title && (course.title + " Feedback"));
            if (x)
                data = data.replace(/John Kimble Feedback/g, x);
        }
        if ((x = course.url))
            data = data.replace(/\nfeedback_url = null/,
                                "\nfeedback_url = \"" + x +
                                encodeURIComponent(course.name) +
                                "/\"");
        return data;
    };
    return f;
}

function send_feedback_file(course, u, req, res) {
    var filename = feedback_files[u.action], fc, mt;
    if (filename != "index.html" && u.pathname.match(/\/$/))
        return redirect(u.action, u, req, res);
    if (/[.]js$/.test(filename))
        mt = "application/javascript";
    else if (/[.]png$/.test(filename))
        mt = "image/png";
    else if (/[.]html$/.test(filename))
        mt = "text/html";
    else
        mt = "application/octet-stream";
    if (mt == "text/html") {
        if (!(fc = course.file_cache[filename]))
            fc = course.file_cache[filename] = new FileCache(filename, mt, make_course_translator(course));
    } else {
        if (!(fc = file_cache[filename]))
            fc = file_cache[filename] = new FileCache(filename, mt);
    }
    fc.send(u, req, res);
}

function server_actions(course, u, req, res) {
    var s, m;

    u.cookie = course.check_cookie(req, res, u.now);
    var req_post = req.method == "POST" || (!course.require_post && req.method == "GET");

    // files
    if (u.action == "" && u.pathname == "/" + course.name)
        return redirect("", u, req, res);
    if (feedback_files[u.action] && !u.subaction)
        return send_feedback_file(course, u, req, res);

    // logout
    if (u.action == "logout" && u.cookie) {
        if ((s = course.s[u.cookie.id]))
            course.deactivate(s, u.now);
        course.clear_cookie(req, res, u.now);
    }
    if (u.action == "logout")
        return redirect("", u, req, res);

    // generate new cookie
    if (!u.cookie) {
        u.cookie = course.set_cookie({id: next_id()}, req, res);
        if (course.need_auth(u.action, false, u.now))
            return course.auth_json_response(u, req, res);
        else
            return json_response(u, req, res, {retry: true});
    }

    // authorization
    if (u.action == "auth")
        return course.handle_auth(u, req, res);

    // status request: no cookie required
    if (u.action == "status")
        return course.status(null, u, req, res);

    // big board
    if (u.action == "panel")
        return course.panel(u, req, res, true);
    // put people on probation
    if (u.action == "probation" && req_post && course.password)
        return course.probation_request(u, req, res);
    else if (u.action == "probation" && req_post)
        return json_response(u, req, res, {error: "password not configured for this course"});

    // debugging report, add phantom users
    if (u.action == "debug" && course.debug)
        return json_response(u, req, res, course.s);
    if (u.action == "phantom" && course.debug) {
        if (u.subaction == "add") {
            course.add_phantom(u.now);
            return json_response(u, req, res, {ok: true});
        } else if (u.subaction == "rm") {
            m = course.rm_phantom(u.now);
            return json_response(u, req, res, {ok: m});
        } else
            return json_response(u, req, res, {error: "unknown subaction"});
    }

    // check authorization
    s = course.s[u.cookie.id];
    if (course.need_auth(u.action, s && s.auth_at, u.now))
        return course.auth_json_response(u, req, res);

    // actions below here are per student; require POST
    if (!req_post)
        return json_response(u, req, res, {error: "unknown GET request"});
    if (!(s = s || course.ensure_user(u.cookie.id, u.now)))
        return json_response(u, req, res, {error: "course full"});
    course.activate(s, u.now);

    // login and lease renewal
    if (u.action == "login")
        return course.status(s, u, req, res);

    // record feedback
    if (u.action == "feedback" && u.subaction) {
        course.feedback(s, u.subaction.toLowerCase(), u.now);
        return course.status(s, u, req, res);
    } else if (u.action == "feedback")
        return json_response(u, req, res, {error: "missing feedback"});

    // ask questions
    if (u.action == "ask" && course.question && course.question_capacity)
        return course.ask_request(s, u, req, res);
    else if (u.action == "ask")
        return json_response(u, req, res, {error: "questions disabled"});

    return json_response(u, req, res, {error: "unknown request"});
}

function server(req, res) {
    var u = url.parse(req.url, true), m;
    u.now = get_now();

    u.remoteAddress = req.connection.remoteAddress;
    if (server_config.proxy && req.headers["x-forwarded-for"]
        && (server_config.proxy === true
            || (server_config.proxy.toLowerCase
                ? server_config.proxy == u.remoteAddress
                : server_config.proxy.test(u.remoteAddress)))) {
        u.proxied = true;
        if ((m = req.headers["x-forwarded-for"].match(/.*?([^\s,]*)[\s,]*$/)))
            u.remoteAddress = m[1];
    }

    var m = u.pathname.match(/^\/([^\/]+)(\/[^\/]+)?(\/.*)?$/);
    if (!m || m[1][0] == "_")
        return json_response(u, req, res, {"error": "missing course"});
    if (m[1] == "favicon.ico")
        return not_found(u, req, res);

    u.course = m[1];
    u.action = m[2] ? m[2].substr(1) : "";
    u.action_path = (m[2] || "") + (m[3] || "") + u.search;
    u.subaction = m[3] ? m[3].substr(1) : "";

    // check for existing course or attack
    if (!courses[u.course] && !create_course(u.course))
        return json_response(u, req, res, {"error": "cannot create course"});
    var course = courses[u.course];

    server_actions(course, u, req, res);

    if (course.update)
        course.finish_update(u.now);
}


// INITIALIZATION

(function () {
    var needargs = {
        port: 1, p: 1, "init-file": 1, config: 1, f: 1,
        "access-log": 1, "error-log": 1
    }, opt = {}, i, x, m, access_log_name, error_log_name;
    for (var i = 2; i < process.argv.length; ++i) {
        if ((m = process.argv[i].match(/^--([^=]*)(=.*)?$/)))
            m[2] = m[2] ? m[2].substr(1) : null;
        else if (!(m = process.argv[i].match(/^-(\w)(.*)$/)))
            break;
        if (needargs[m[1]] && !m[2])
            m[2] = process.argv[++i];
        opt[m[1]] = m[2] ? m[2] : true;
    }

    server_id = Math.floor(get_now() / 1000 - 1000000000);
    make_next_id();

    if ((x = opt["init-file"] || opt.config || opt.f))
        eval(fs.readFileSync(x, "utf8"));
    else if (!opt["no-init-file"] && fs.existsSync("jkconfig.js"))
        eval(fs.readFileSync("jkconfig.js", "utf8"));
    else if (!opt["no-init-file"] && fs.existsSync("serverconfig.js")) {
        console.warn("'serverconfig.js' is deprecated, prefer 'jkconfig.js' for configuration");
        eval(fs.readFileSync("serverconfig.js", "utf8"));
    }

    access_log_name = opt["access-log"] || server_config.access_log;
    if (access_log_name == "-" || access_log_name == "stdout")
        access_log_name = "inherit";
    error_log_name = opt["error-log"] || server_config.error_log;

    if (!opt.fg) {
        if (access_log_name != "ignore" && access_log_name != "inherit")
            access_log_name = "ignore";
        if (error_log_name != "ignore" && error_log_name != "inherit")
            error_log_name = fs.openSync(error_log_name, "a");
        require("child_process").spawn(process.argv[0],
                                       process.argv.slice(1).concat(["--fg", "--nohup"]),
                                       {stdio: ["ignore",
                                                access_log_name,
                                                error_log_name],
                                        detached: true});
        process.exit();
    }
    if (opt.nohup)
        process.on("SIGHUP", function () {});
    if (opt.port || opt.p)
        server_config.port = +(opt.port || opt.p);

    server_config.opened_access_log = false;
    if (access_log_name == "ignore")
        access_log = fs.createWriteStream("/dev/null", {flags: "a"});
    else if (access_log_name && access_log_name != "inherit") {
        server_config.opened_access_log = true;
        access_log = fs.createWriteStream(access_log_name, {flags: "a"});
    }
})();

(function () {
    var s = http.createServer(server);
    s.on("error", function (e) {
        if (e.code != "EMFILE") {
            console.log(e.toString());
            process.exit(1);
        }
    });
    s.listen(server_config.port, function () {
        var now = get_now(), access_log_sep = "", stats, server_path;
        if (server_config.opened_access_log
            && (stats = fs.statSync(server_config.access_log))
            && stats.isFile() && stats.size != 0)
            access_log_sep = "\n";
        server_path = "http://" + (server_config.host || "localhost") + ":" + server_config.port + "/";
        log_access({remoteAddress: access_log_sep + "-", now: get_now()},
                   {method: "START", headers: {}}, server_path, {statusCode: 0});
        console.warn("[%s] John Kimble server running at %s",
                     log_date_format(now), server_path);
    });
})();
