johnkimble_load = (function () {

var $ = jQuery;
feedback_url = window.feedback_url || "";
var status = {s: {}}, probation = false;
var feedback_asking = false;
var clock_offset = 0;
var statuses = {"0": "cancel", ok: "ok", stop: "stop", ask: "ask"};
var pulse_duration = 150;
var boardstatus = {}, boardsizes = {},
    boardqs = {}, boardinfo = {}, boardcolorre = null,
    board_outstanding = false, board_backoff = 0, board_backoffuntil = 0;
var compact_window = !!window.location.search.match(/[?&]neww=1/);
var colors = {
    pulse: $.Color("#ffff00"),
    board0: {off: $.Color("#ffffff"), offborder: $.Color("#778ee9")},
    "0": {off: $.Color("#f0e5d3"), on: $.Color("#ded4c3")},
    ok: {off: $.Color("#f0e5d3"), on: $.Color("#00ed2d"),
	 onborder: $.Color("#008800")},
    stop: {off: $.Color("#f0e5d3"), on: $.Color("#ff0000"),
	   onborder: $.Color("#880000")},
    ask: {off: $.Color("#f0e5d3"), on: $.Color("#86bbee"),
	  onborder: $.Color("#778ee9"), inset: $.Color("#2089ee").alpha(0.7)}
};
var default_style = [colors.board0.off, colors.board0.offborder];
$.Color.names.orange = "#FFA500";
$.Color.names.pink = "#FF69B4"; // actually "HotPink"


// Return a zero-argument function whose body calls `f(a1, a2, ...)`.
function bind(f /* , a1, a2, ... */) {
    var args = Array.prototype.slice.call(arguments, 1);
    return function () {
	return f.apply(null, args);
    };
}


// Timer scheduler for animations. `f` is the callback function
// called to draw the next step of the animation.
function new_animation_timer(f, interval_factor) {
    var timeout = null, interval = null, now = null, next_expiry = null;
    function timeout_f() {
	timeout = null;
	f();
    }
    var a = {
	interval: Math.min($.fx.interval * (interval_factor || 1), 100),
	// Start the scheduling process. The current time is `t`.
	start: function (t) {
	    now = t;
	    next_expiry = Infinity;
	},
	// Mark an animation step for time `t`.
	schedule_at: function (t) {
	    if (t)
		next_expiry = Math.min(next_expiry, t);
	},
	// Calculate the transition color for the current time and return it.
	// Also mark an animation step appropriately.
	color_transition: function (/* color0, t0, color1, t1, ... */) {
	    var i = 0, x = arguments;
	    while (x[i + 2] && now >= x[i + 2])
		i += 2;
	    if (i == 0 && now < x[i]) {
		a.schedule_at(x[i]);
		return x[i + 1];
	    } else if (!x[i + 2] || x[i + 1] == x[i + 3]) {
		a.schedule_at(x[i + 2]);
		return x[i + 1];
	    } else {
		a.schedule_at(now);
		return x[i + 1].transition(x[i + 3], $.easing.swing((now - x[i]) / (x[i + 2] - x[i])));
	    }
	},
	// Schedule an animation step for the minimum marked time since
	// `start()` was called.
	finish: function () {
	    timeout && (clearTimeout(timeout), timeout = null);
	    if (next_expiry > now + a.interval) {
		interval && (clearInterval(interval), interval = null);
		if (next_expiry != Infinity)
		    timeout = setTimeout(timeout_f, next_expiry - now);
	    } else
		interval = interval || setInterval(f, a.interval);
	}
    };
    return a;
}
var board_animator = null, status_animator = null;


function make_easing(start) {
    return function (p) {
	return $.easing.swing(start + p * (1 - start));
    };
}

function draw_status() {
    var now = (new Date).getTime() + clock_offset, s, e, active;
    status_animator = status_animator || new_animation_timer(draw_status);
    status_animator.start(now);
    for (s in statuses) {
	e = $("#feedback_" + statuses[s]);
	if (s == "ask" ? status.question_at : status.feedback == s) {
	    var t_start = status[s == "ask" ? "question_at" : "feedback_at"],
	        t_pulse = t_start + pulse_duration,
	        t_hold = t_start + status.hold_duration,
	        t_end = t_start + status.duration;
	    var c = status_animator.color_transition(t_start, colors.pulse,
						     t_pulse, colors[s].on,
						     t_hold, colors[s].on,
						     t_end, colors[s].off);
	    e.css("backgroundColor", c);
	} else if (status.lease)
	    e.css("backgroundColor", colors[s].off);
	else
	    e.css("backgroundColor", "");
    }
    if (status.lease)
	$("#feedback_ask").toggle(status.ask);
    if (status.probation_until && status.probation_until <= now)
        status.probation_until = null;
    if (!status.probation_until != !probation) {
        probation = status.probation_until;
        $("#feedback_stop button.feedbutton").html(probation ? "YOU’RE" : "STOP");
        $("#feedback_ok button.feedbutton").html(probation ? "ON" : "GO");
        $("#feedback_ask button.feedbutton").html(probation ? "PROBATION" : "ASK");
        if (probation) {
            feedback_ask_done(null);
            setTimeout(draw_status, now - probation);
        }
    }
    status_animator.finish();
}


function make_responder(retry, success) {
    var backoff = 0;
    return function(data) {
	if (data.retry) {
	    setTimeout(retry, backoff);
	    backoff = Math.min(Math.max(backoff * 2, 250), 30000);
	} else if (data.auth)
	    do_auth(data, retry);
	else
	    success(data);
    };
}

function make_auth_responder(success) {
    return function(data) {
	if (!data.error) {
	    $("#feedback_authorized").show();
	    $("#feedback_recaptcha_container").hide();
	    RecaptchaOptions.extra_challenge_params = "";
	    return success();
	} else {
	    RecaptchaOptions.extra_challenge_params = "error=" + data.recaptcha_error;
	    do_auth(data, success);
	}
    };
}

function do_auth(data, success) {
    if (data.auth != "recaptcha" || !data.recaptcha_public)
	return alert("Internal error: unknown authentication");

    if (!window.Recaptcha) {
	$.getScript("http://www.google.com/recaptcha/api/js/recaptcha_ajax.js",
		    bind(do_auth, data, success));
	return;
    }

    var j = $("#feedback_recaptcha_container form");
    if (!j.attr("auth_installed"))
	j.attr({action: feedback_url + "auth", auth_installed: true})
	.submit(function (e) {
	    $.ajax({
		url: feedback_url + "auth?ajax=true", cache: false,
		data: {
		    recaptcha_challenge_field: Recaptcha.get_challenge(),
		    recaptcha_response_field: Recaptcha.get_response()
		},
		type: "POST", dataType: "json",
		success: make_auth_responder(success),
		xhrFields: {withCredentials: true}
	    });
	    return false;
	});
    Recaptcha.create(data.recaptcha_public, "feedback_recaptcha_div", {
	callback: function () {
	    $("#feedback_authorized").hide();
	    $("#feedback_recaptcha_container").show();
	    Recaptcha.focus_response_field();
	},
	extra_challenge_params: data.recaptcha_error ? "error=" + data.recaptcha_error : ""
    });
}

var manage_lease = (function () {
    var backoff = 0, timeout = null, login_success;
    function success(data) {
	var lease = ($.isPlainObject(data) && data.lease)
	    || (status && status.lease) || 0;
	if (lease) {
	    backoff = 0;
	    set_status(data);
	    timeout = setTimeout(send_login, Math.max(lease - 10000, 10000));
	} else
	    error();
    }
    function error() {
	set_status({});
	backoff = Math.min(Math.max(backoff, 500) * 2, 180000);
	timeout = setTimeout(send_login, backoff);
    }
    function send_login() {
	timeout = null;
	$.ajax({
	    url: feedback_url + "login", cache: false, data: "",
	    type: "POST", dataType: "json", timeout: Math.max(backoff, 2000),
            success: login_success, error: error,
	    xhrFields: {withCredentials: true}
	});
    }
    login_success = make_responder(send_login, success);
    return function (arg) {
	if (timeout)
	    clearTimeout(timeout);
	arg === true ? send_login() : error();
    };
})();

function set_status(data) {
    var good = $.isPlainObject(data) && data.now && data.lease;
    if (good) {
	status = data;
	clock_offset = data.now - (new Date).getTime();
    } else
	status = {};
    $(".feedback").toggleClass("feedback_active", !!good);
    draw_status();
}

function feedback(type) {
    if (feedback_asking)
	feedback_ask_done(null);
    $.ajax({
	url: feedback_url + "feedback/" + type, cache: false, data: "",
	type: "POST", dataType: "json", timeout: 3000,
	success: make_responder(bind(feedback, type), set_status),
	error: manage_lease,
	xhrFields: {withCredentials: true}
    });
}

function feedback_ask() {
    if (probation || !status || !status.lease)
        return;
    $("#feedback_ask").height($("#feedback_stop").height());
    $("#feedback_ask .feedback_text").stop(true).fadeOut(250);
    $("#feedback_ask_entry").stop(true).fadeIn(250);
    $("#feedback_ask_q").focus();
    $("#feedback_ask_container").animate({width: Math.min($(window).width() - 10, $("#feedback_stop_container").width() * 2), height: $("#feedback_stop_container").height()}, {duration:250});
    feedback_asking = true;
}

function feedback_ask_ask() {
    var s, m;
    if ((s = $("#feedback_ask_q").val())) {
	$.ajax({
	    url: feedback_url + "ask", cache: false, data: {q: s},
	    type: "POST", dataType: "json", timeout: 3000,
	    success: make_responder(feedback_ask_ask, feedback_ask_done),
	    error: function () { feedback_ask_done(null); manage_lease(); },
	    xhrFields: {withCredentials: true}
	});
        if ((m = s.match(/^\{\s*style(?:\s+.*?|)\}(.*)/)))
            $("#feedback_ask_q").val(m[1]);
    }
}

function feedback_ask_done(data) {
    $("#feedback_ask_entry, #feedback_ask .feedback_text, #feedback_ask_container").stop(true, true);
    $("#feedback_ask_entry").fadeOut(250);
    $("#feedback_ask .feedback_text").fadeIn(250);
    if (data === null)
	$("#feedback_ask_q").val("");
    $("#feedback_ask").focus();
    var e = $("#feedback_stop_container");
    $("#feedback_ask_container").animate({width: e.width(), height: e.height()}, {duration:250});
    feedback_asking = false;
    if (data !== null)
	set_status(data);
}


function getboard() {
    var now = (new Date).getTime(), polltime;
    if (board_outstanding || board_backoffuntil > now)
        return;
    polltime = (board_backoff ? 0 : boardstatus.updated_at || 0);
    board_outstanding = true;
    $.ajax({
	url: feedback_url + "panel?poll=" + polltime, cache: false, data: "",
	type: "GET", dataType: "json",
	success: store_board,
	error: function (xhr, status, http_error) {
	    setTimeout(getboard, board_backoff);
            board_outstanding = false;
	    board_backoff = Math.min(Math.max(board_backoff * 2, 250), 30000);
            board_backoffuntil = (new Date).getTime() + board_backoff;
	},
        xhrFields: {withCredentials: true}
    });
}

function store_board(data) {
    board_outstanding = false;
    board_backoff = 0;

    // save status
    boardstatus = data;
    clock_offset = data.now - (new Date).getTime();

    // remove old questions that don't have current students
    var i, q, qs, x = {}, stati = boardstatus.s;
    for (i in boardqs)
	if (!(i in stati) || stati[i].probation_until > data.now)
	    x[i] = 1;
    for (i in x)
	delete boardqs[i];
    if (boardinfo.hovers && boardinfo.hovers.i in x) {
        boardinfo.hovers = null;
        $(".showquestion").remove();
    }

    // add remaining questions
    if ((qs = data.qs))
	for (i = 0; i < qs.length; ++i) {
	    q = qs[i];
	    x = boardqs[q[0]] = boardqs[q[0]] || [];
	    x.unshift([q[1], q[2]]);
	}

    draw_board(0);
    getboard();
}

var feedback_shapes = (function () {
    var pi = Math.PI, cos = Math.cos, sin = Math.sin, sqrt = Math.sqrt,
        max = Math.max, atan2 = Math.atan2;

    function pen(ctx, x, y, r, min_r) {
	var op = "moveTo";
	return function (dr, a) {
	    dr = max(r * dr, min_r || 0);
	    ctx[op](x + dr * cos(a), y - dr * sin(a));
	    op = "lineTo";
	};
    }

    function cartesian_pen(ctx, x, y, r, min_r) {
        var p = pen(ctx, x, y, r, min_r);
        return function (dx, dy) {
            p(sqrt(dx*dx + dy*dy), atan2(dy, dx));
        };
    }

    function make_polygon(dr, start, n) {
	return function (ctx, x, y, r, min_r) {
	    var p = pen(ctx, x, y, r, min_r), i, d = 2*pi / n;
	    for (i = 0; i < n; ++i)
		p(dr, start + i * d);
	    ctx.closePath();
	};
    }

    function make_star(drs, start, n) {
	return function (ctx, x, y, r, min_r) {
	    var p = pen(ctx, x, y, r, min_r), i, d = pi / n;
	    for (i = 0; i < 2 * n; ++i)
		p(drs[i & 1], start + i * d);
	    ctx.closePath();
	};
    }

    var arrow_info = [1.02, 0,  0.95, 0.57*pi,
		      1.02 * sin(0.84*pi) / sin(0.57*pi), 0.57*pi,  1.02, 0.84*pi];
    function make_arrow(direction) {
	return function (ctx, x, y, r, min_r) {
	    var p = pen(ctx, x, y, r, min_r), i;
	    for (i = 0; i < arrow_info.length; i += 2)
		p(arrow_info[i], direction + arrow_info[i + 1]);
	    for (i -= 2; i > 0; i -= 2)
		p(arrow_info[i], direction - arrow_info[i + 1]);
	    ctx.closePath();
	};
    }

    function draw_x(ctx, x, y, r, min_r) {
	var p = pen(ctx, x, y, r, min_r), a;
	for (a = 0; a < 2*pi; a += pi/2) {
	    p(0.5466, a);
	    p(1.01, a + pi/8);
	    p(1.01, a + 3*pi/8);
	}
	ctx.closePath();
    }

    function draw_o(ctx, x, y, r, min_r) {
	ctx.arc(x, y, r, 0, 7);
	var smr = r - Math.max(0.7*r, 4);
	if (smr > 0) {
	    ctx.moveTo(x + smr, y);
	    ctx.arc(x, y, smr, 0, -7, true);
	}
    }

    function draw_t(ctx, x, y, r, min_r) {
	var p = cartesian_pen(ctx, x, y, r, min_r);
        p(-0.93, 0.98);
        p(0.93, 0.98);
        p(0.93, 0.29);
        p(0.38, 0.29);
        p(0.38, -0.98);
        p(-0.38, -0.98);
        p(-0.38, 0.29);
        p(-0.93, 0.29);
        ctx.closePath();
    }

    return {
	circle: null,
	square: make_polygon(sqrt(pi/2), pi/4, 4),
	diamond: make_polygon(sqrt(pi/2), 0, 4),
	octagon: make_polygon(sqrt(pi/(4*Math.SQRT1_2)), pi/8, 8),
	star: make_star([1.2, 0.6], pi/2, 5),
	star7: make_star([1.2, 0.7], -pi/2, 7),
	seal: make_star([1.1, 0.9], -pi/2, 18),
	triangle: make_polygon(sqrt(pi/2), pi/2, 3),
	tri: make_polygon(sqrt(pi/2), pi/2, 3),
	invtriangle: make_polygon(sqrt(pi/2), -pi/2, 3),
	invtri: make_polygon(sqrt(pi/2), -pi/2, 3),
	n: make_arrow(pi/2),
	nw: make_arrow(3*pi/4),
	w: make_arrow(pi),
	sw: make_arrow(5*pi/4),
	s: make_arrow(-pi/2),
	se: make_arrow(-pi/4),
	e: make_arrow(0),
	ne: make_arrow(pi/4),
	x: draw_x,
	o: draw_o,
        t: draw_t,
        tee: draw_t
    };
})();

function make_boardcolorre() {
    var i, t = "(?:#[0-9a-f]{3}|#[0-9a-f]{6}";
    for (i in $.Color.names)
	if (i != "_default")
	    t += "|" + i;
    return new RegExp(t + ")", "i");
}

function feedback_style(s, sq, f, feedback_at, cutoff) {
    var m, a, b, i, shape, style = [];

    if (s && s.style) {
        sq = sq || [cutoff, ""];
        if (sq[1].charAt(0) == "{" && (m = sq[1].match(/^\{\s*(.*?)\}(.*)$/)))
            sq[1] = "{" + s.style + " " + m[1] + "}" + m[2];
        else
            sq[1] = "{" + s.style + "}" + sq[1];
    }

    if (sq && sq[0] >= (cutoff || 0) && sq[1].charAt(0) == "{"
	&& (m = sq[1].match(/^\{(.*?)\}(.*)$/))) {
	a = m[1].split(/[\s,]+/);
	b = [];
	boardcolorre = boardcolorre || make_boardcolorre();

	for (i = 0; i < a.length; ++i)
	    if (boardcolorre.test(a[i])) {
		if (sq[0] >= (feedback_at || 0)) {
		    style[0] = new $.Color(a[i]);
		    style[1] = style[0].transition($.Color("black"), 0.2);
		}
	    } else if (a[i] in feedback_shapes)
		style[2] = feedback_shapes[a[i]];
	    else if (a[i] != "style")
		b.push(a[i]);

	if (b.length)
	    style[3] = "{" + b.join(" ") + "}" + m[2];
	else
	    style[3] = m[2];
    } else if (sq)
	style[3] = sq[1];

    if (!f || !colors[f])
        f = "0";
    if (!style[0])
	style[0] = colors[f].on;
    if (!style[1])
	style[1] = colors[f].onborder || style[0];
    return style;
}

function draw_board() {
    var e = $("#feedbackboard"), cv = e[0];

    // canvas-dependent sizes
    var cellsize = 30, xborder = 10, yborder = 10, nacross, ndown;
    while (1) {
	nacross = Math.floor((cv.width - 2 * xborder) / cellsize);
	ndown = Math.floor((cv.height - 2 * yborder) / cellsize);
	if (nacross * ndown >= (boardstatus.nordinal || 0) || cellsize == 10)
	    break;
	if (cellsize == 30) {
	    cellsize = Math.sqrt((cv.width - 10) * (cv.height - 10) / boardstatus.nordinal);
	    cellsize = Math.max(10, Math.min(29, Math.floor(cellsize)));
	} else
	    --cellsize;
	if (cellsize < 15)
	    xborder = yborder = 5;
    }

    if (ndown * cellsize + 2 * yborder > e.attr("height"))
	e.attr({height: ndown * cellsize + 2 * yborder});

    $.extend(boardinfo, {cellsize: cellsize, xborder: xborder, yborder: yborder, nacross: nacross});

    // time constants
    var now = (new Date).getTime() + clock_offset,
	duration = boardstatus.duration,
	hold_duration = boardstatus.hold_duration,
	emphasis_duration = boardstatus.emphasis_duration;
    var t_start, t_pulse, t_emphasis, t_hold, t_end;

    // drawing constants
    var ctx = cv.getContext("2d"),
	smallrad = cellsize / 10,
	qrad = smallrad * 2.5,
	largerad = smallrad * 4,
	maxrad = smallrad * 6,
	background = $.Color(232, 232, 242),
	swing = $.easing.swing;
    var i, j, s, ssize, sqs, r, x, y, overlap, f, style;

    // restart animator
    board_animator = board_animator || new_animation_timer(draw_board, 3);
    board_animator.start(now);

    // calculate radii
    for (i in boardstatus.s) {
	s = boardstatus.s[i];
	f = s.feedback || "0";
	t_start = s.feedback_at || 0;
	if ((sqs = boardqs[i]) && sqs[0][0] > t_start && sqs[0][1]) {
	    t_start = sqs[0][0];
	    f = "ask";
	}
	t_end = t_start + duration;

	if (f == "0" || now >= t_end)
	    r = smallrad;
	else {
	    if (s.emphasis > 1 && now < t_start + emphasis_duration) {
		r = Math.min(maxrad, Math.sqrt(largerad * largerad * (s.emphasis + 1) / 2));
		r += swing((now - t_start) / emphasis_duration) * (largerad - r);
		board_animator.schedule_at(now);
	    } else
		r = largerad;

	    t_hold = t_start + hold_duration;
	    if (now > t_hold) {
		x = swing((now - t_hold) / (t_end - t_hold));
		r = r - x * (r - smallrad);
	    }
	}

	if (!(ssize = boardsizes[i]))
	    ssize = boardsizes[i] = {r: r, gr: r, at: now};
	if (r > ssize.r) {
	    if (r > ssize.gr) {
		ssize.lr = ssize.r;
		ssize.gr = r;
		ssize.at = now;
	    }
	    x = swing(Math.min(1, (now - ssize.at) / pulse_duration));
	    r = ssize.lr + x * (r - ssize.lr);
	    board_animator.schedule_at(now);
	} else
	    ssize.gr = r;
	ssize.r = r;
    }

    // calculate overlap
    overlap = {};
    for (i in boardsizes) {
	ssize = boardsizes[i];
	for (x = 0; x < 4 && !overlap[i]; ++x) {
	    j = (+i + (x & 2 ? 2 * x - 5 : (2 * x - 1) * nacross)) + "";
	    if ((s = boardsizes[j]) && ssize.r + s.r + 2 >= cellsize)
		overlap[i] = overlap[j] = true;
	}
    }

    // draw board
    ctx.fillStyle = background.toRgbaString();
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.strokeStyle = "rgba(248, 208, 208, 0.2)";
    ctx.lineWidth = 8;
    ctx.strokeRect(0, 0, cv.width, cv.height);
    ctx.strokeStyle = "rgba(248, 208, 208, 0.1)";
    ctx.lineWidth = 16;
    ctx.strokeRect(0, 0, cv.width, cv.height);

    // fills and strokes
    for (i in boardstatus.s) {
	s = boardstatus.s[i];
	f = s.feedback || "0";
	t_start = s.feedback_at || 0;
	if ((sqs = boardqs[i]) && sqs[0][0] > t_start && sqs[0][1]) {
	    t_start = sqs[0][0];
	    f = "ask";
	}
	t_end = t_start + duration;

	if ((f == "0" || now >= t_end) && !s.style) {
	    ctx.lineWidth = 0.5;
	    style = default_style;
	} else {
	    t_hold = t_start + hold_duration;
	    style = feedback_style(s, sqs && sqs[0], f, t_start,
				   now - duration);
	    if (now <= t_hold)
		ctx.lineWidth = 3;
	    else {
		x = swing((now - t_hold) / (t_end - t_hold));
		ctx.lineWidth = 3 - 2.5 * x;
		style[1] = style[1].transition(colors.board0.offborder, x);
	    }
	    style[0] = board_animator.color_transition(t_hold, style[0],
						       t_end, colors.board0.off);
	}

	if (overlap[i]) {
	    style[0] = style[0].alpha(0.8);
	    style[1] = style[1].alpha(0.8);
	}

	ctx.beginPath();
	x = ((i % nacross) + 0.5) * cellsize + xborder;
	y = (Math.floor(i / nacross) + 0.5) * cellsize + yborder;
	if (style[2])
	    style[2](ctx, x, y, boardsizes[i].r, smallrad);
	else
	    ctx.arc(x, y, boardsizes[i].r, 0, 7);
	ctx.fillStyle = style[0].toRgbaString();
	ctx.fill();
	ctx.strokeStyle = style[1].toRgbaString();
	ctx.stroke();

	if (style[3] && sqs[0][0] > now - duration && f != "ask") {
	    ctx.beginPath();
	    ctx.arc(x, y, boardsizes[i].r / 2, 0, 7);
	    ctx.fillStyle = colors.ask.inset.toRgbaString();
	    ctx.fill();
	}
    }

    // done
    board_animator.finish();
}

var resize_feedbackboard = (function () {
    var history = [], delta = 0;
    return function () {
	var w$ = $(window), w = w$.width(), h = w$.height(), i;
	for (i = 0; i != history.length; ++i)
	    if (history[i][0] == w && history[i][1] == h)
		break;
	if (i == 0 && i != history.length) {
	    $("#feedbackboard").attr({width: w - delta, height: h - delta});
	    return draw_board(0);
	}
	var now = (new Date).getTime();
	if (i != history.length && history[i][2] + 200 > now)
	    delta += 1;
	else if (history.length && history[0][2] + 500 < now)
	    delta = 0;
	if (history.length > 10)
	    history.pop();
	history.unshift([w, h, now]);
	$("#feedbackcontainer").css({width: w - delta, height: h - delta});
	setTimeout(resize_feedbackboard, 1);
    };
})();

function hover_board_status(x, y) {
    var na, xb, yb, cs, q, xc, yc, r;
    if (!(na = boardinfo.nacross))
	return null;
    xb = boardinfo.xborder;
    yb = boardinfo.yborder;
    cs = boardinfo.cellsize;
    if (x < xb || y < yb || x >= xb + na * cs)
	return null;
    i = Math.floor((x - xb) / cs) + Math.floor((y - yb) / cs) * na;
    if (!boardstatus.s[i])
        return null;
    xc = xb + (i % na + 0.5) * cs;
    yc = yb + (Math.floor(i / na) + 0.5) * cs;
    r = Math.sqrt((xc - x) * (xc - x) + (yc - y) * (yc - y));
    if (r > boardsizes[i].r + 2)
	return null;
    q = boardqs[i];
    return {i: i, q: q ? q[0][0] : null, x: xc, y: yc};
}

function board_position() {
    var b = $("#feedbackboard");
    var bpos = b.offset();
    bpos.width = b.width();
    bpos.height = b.height();
    return bpos;
}

function hover_board(e) {
    var bpos = board_position();
    var x = e.pageX - bpos.left, y = e.pageY - bpos.top;
    var hs = hover_board_status(x, y);
    if (boardinfo.hovers && boardinfo.hovers.q) {
        if (hs && hs.i == boardinfo.hovers.i && hs.q == boardinfo.hovers.q)
            return;
        $(".showquestion").remove();
    }
    boardinfo.hovers = hs;
    if (!hs || !hs.q)
	return;

    var b = boardqs[hs.i];
    var s = boardstatus.s[hs.i];
    var t, i, j;
    for (i = j = 0; j < 3 && i < b.length; ++i) {
	x = feedback_style(s, b[i]);
	if (!x[3])
	    continue;
	if (!t) {
	    t = $("<div class='showquestion' style='position:absolute;visibility:hidden;top:0;left:0'></div>");
	    t.append("<div class='qtail0'></div>");
	}
	t.append($("<div class='q q" + j + "'></div>").text(x[3]));
	++j;
    }
    if (!t)
	return;
    t.append("<div class='qtail1'></div>");
    t.appendTo($("#feedbackcontainer"));
    t.find(".q").css({maxWidth: bpos.width - 30});

    // position the question
    var tw = t.outerWidth(), th = t.outerHeight(), tpos;
    var spl = hs.x - (tw + 16), spr = bpos.width - hs.x - (tw + 16),
        spt = hs.y - (th + 16), spb = bpos.height - hs.y - (th + 16);
    if (spl > 0 && spl > 1.2 * spr) {
	x = hs.x - 16 - tw;
        y = hs.y - th + Math.max(th / 2, 18);
	tpos = "r";
    } else if (spr > 0) {
	x = hs.x + 16;
        y = hs.y - Math.max(th / 2, 16);
	tpos = "l";
    } else if (spt > 0 || spt > 1.2 * spb) {
	x = hs.x - tw / 2;
	y = Math.max(hs.y - 16 - th, 5);
	tpos = "b";
    } else {
	x = hs.x - tw / 2;
	y = Math.min(hs.y + 16, bpos.height - th - 5);
	tpos = "t";
    }
    t.find(".qtail0, .qtail1").addClass(tpos);
    if (x < 5 || x > bpos.width - tw - 5)
        x = Math.max(5, bpos.width - tw - 5);
    if (y < 2 || y > bpos.height - th - 2)
        y = Math.max(-5, bpos.height - th - 2);
    x = Math.floor(x);
    y = Math.floor(y);
    if (tpos == "l") {
	spt = Math.max(hs.y - y - 9, 5);
	t.find(".qtail0, .qtail1").css({top: spt});
    } else if (tpos == "r") {
	spt = Math.min(hs.y - y, th - 16);
	t.find(".qtail0").css({top: spt});
	t.find(".qtail1").css({top: spt + 1});
    } else {
	spl = Math.max(hs.x - x - 9, 5);
	t.find(".qtail0, .qtail1").css({left: spl});
    }
    t.css({visibility: "visible", left: bpos.left + x, top: bpos.top + y});
}

function set_probation(s, password) {
    var data = s == null ? {} : {s: s};
    if (password)
        data.password = password;
    $.ajax({
	url: feedback_url + "probation", cache: false, data: data,
	type: "POST", dataType: "json", timeout: 3000,
        success: function (data) {
            var j;
            if (data.panel_auth) {
                $(".modal").remove();
                j = $("<div class='modal'><form><div class='modalin'>"
                      + (data.panel_auth_fail ? "<div style='padding-bottom:0.5em;color:red'>That password is incorrect.</div>" : "")
                      + "Enter the course password."
                      + "<div style='padding:0.5em 0'><input type='password' name='password' style='width:95%' /></div><div style='text-align:right'><button type='button' name='cancel'>Cancel</button> <input type='submit' name='go' value='OK' /></div></div></form></div>");
                j.find("form").submit(function () {
                    j.remove();
                    set_probation(s, j.find("[name='password']").val());
                    return false;
                });
                j.find("[name='cancel']").click(function () {
                    j.remove();
                });
                j.appendTo($("body"));
                j.find("[name='password']").focus();
            }
        },
	xhrFields: {withCredentials: true}
    });
}

function click_board(e) {
    hover_board(e);
    if (e.button == 0 && (e.shiftKey || e.ctrlKey)) {
        if (boardinfo.hovers)
            set_probation(boardinfo.hovers.i);
        else if (!boardstatus.panel_auth)
            set_probation(null);
    }
}


return function () {
    if ($("#feedback_stop").length) {
	$("#feedback_ok").click(function () { feedback("ok"); });
	$("#feedback_stop").click(function () { feedback("stop"); });
	$("#feedback_ask").click(function () { feedback_ask(); });
	$("#feedback_ask_entry form").submit(function () { feedback_ask_ask(); return false; });
	$("#feedback_cancel").click(function () { feedback("cancel"); });
	$("#feedback_recaptcha").click(function (e) {
	    $(this).parents("form").submit();
	    e.preventDefault();
	});
	manage_lease(true);
    }
    if ($("#feedbackboard").length) {
	setTimeout(getboard, 2);
        setInterval(getboard, 10000); // keep board running in case of exception
	$("#feedbackboard").mousemove(hover_board).click(click_board);
    }
    if (compact_window) {
	$("#newwindowlink").hide();
	if ($("#feedbackboard").length) {
	    $("#feedbackcontainer").css({position: "relative", overflow: "hidden"});
	    $("body").css({margin: 0});
	    $(window).resize(resize_feedbackboard);
	    setTimeout(resize_feedbackboard, 1);
	}
    } else
	$("#newwindowlink").click(function () {
	    t = (this.href.match(/\?/) ? "&" : "?") + "neww=1";
	    window.open(this.href + t, "feedback61_window", "titlebar=no,dialog=yes,close=no,width=640,height=40");
	});
};

})();
