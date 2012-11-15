(function () {

var $ = jQuery;
feedback_url = window.feedback_url || "";
var status = {};
var feedback_asking = false;
var clock_offset = 0;
var statuses = {"0": "cancel", ok: "ok", stop: "stop", ask: "ask"};
var pulse_duration = 150;
var boardstatus = {}, boardsizes = {}, boardbackoff = 0,
    boardqs = {}, boardinfo = {}, boardcolorre = null;
var compact_window = !!window.location.search.match(/[?&]neww=1/);
var colors = {
    pulse: $.Color("#ffff00"),
    board0: {off: $.Color("#ffffff"), offborder: $.Color("#778ee9")},
    "0": {off: $.Color("#ded4c3"), on: $.Color("#ded4c3")},
    ok: {off: $.Color("#ded4c3"), on: $.Color("#00ed2d"),
	 onborder: $.Color("#008800")},
    stop: {off: $.Color("#ded4c3"), on: $.Color("#ff0000"),
	   onborder: $.Color("#880000")},
    ask: {off: $.Color("#ded4c3"), on: $.Color("#86bbee"),
	  onborder: $.Color("#778ee9"), inset: $.Color("#2089ee").alpha(0.7)}
};


function new_animator(f, interval_factor) {
    var timeout = null, interval = null, now = null, next_expiry = null;
    var a = {
	interval: Math.min($.fx.interval * (interval_factor || 1), 100),
	clear: function (n, from_timeout) {
	    if (!from_timeout)
		clearTimeout(timeout);
	    timeout = null;
	    now = n;
	    next_expiry = Infinity;
	},
	update_at: function (e) {
	    if (e)
		next_expiry = Math.min(next_expiry, Math.max(now + a.interval, e));
	},
	go: function () {
	    if (next_expiry == Infinity)
		/* do nothing */;
	    else if (next_expiry > now + a.interval) {
		if (interval) {
		    clearInterval(interval);
		    interval = null;
		}
		timeout = setTimeout(f, next_expiry - now, 1);
	    } else
		interval = interval || setInterval(f, a.interval, 0);
	}
    };
    return a;
}
var board_animator = null, status_animator = null;


function make_easing(start) {
    return function (p) {
	return jQuery.easing.swing(start + p * (1 - start));
    };
}

function colorat(now, animator /* ... */) {
    var i = 2;
    while (arguments[i + 2] && now >= arguments[i + 2])
	i += 2;
    if (!arguments[i + 2] || arguments[i + 1] == arguments[i + 3]) {
	animator.update_at(arguments[i + 2]);
	return arguments[i + 1];
    } else {
	animator.update_at(now);
	return arguments[i + 1].transition(arguments[i + 3],
					   jQuery.easing.swing((now - arguments[i]) / (arguments[i + 2] - arguments[i])));
    }
}

function draw_status(from_timeout) {
    var now = (new Date).getTime() + clock_offset, s, e, active;
    status_animator = status_animator || new_animator(draw_status);
    status_animator.clear(now, from_timeout);
    for (s in statuses) {
	e = $("#feedback_" + statuses[s]);
	if (s == "ask" ? status.question_at : status.feedback == s) {
	    var t_start = status[s == "ask" ? "question_at" : "feedback_at"],
	        t_pulse = t_start + pulse_duration,
	        t_hold = t_start + status.hold_duration,
	        t_end = t_start + status.duration;
	    var c = colorat(now, status_animator,
			    t_start, colors.pulse,
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
    status_animator.go();
}


function make_function(f) {
    if ($.isArray(f))
	return function() {
	    f[0].apply(null, f.slice(1));
	};
    else
	return f;
}

function make_responder(retry, success) {
    var backoff = 0;
    return function(data) {
	if (data.retry) {
	    setTimeout(make_function(retry), backoff);
	    backoff = Math.min(Math.max(backoff * 2, 250), 30000);
	} else if (data.auth)
	    do_auth(data, make_function(retry));
	else
	    make_function(success)(data);
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
		    make_function([do_auth, data, success]));
	return;
    }

    var j = $("#feedback_recaptcha_container form");
    if (!j.attr("auth_installed"))
	j.attr({action: feedback_url + "auth", auth_installed: true})
	.submit(function (e) {
	    $.ajax({
		url: feedback_url + "auth?ajax=true",
		type: "POST", dataType: "json",
		data: {
		    recaptcha_challenge_field: Recaptcha.get_challenge(),
		    recaptcha_response_field: Recaptcha.get_response()
		},
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
    var backoff = 0, timeout = null;
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
	    url: feedback_url + "login",
	    type: "POST", dataType: "json", timeout: Math.max(backoff, 2000),
	    success: make_responder(send_login, success),
	    error: error,
	    xhrFields: {withCredentials: true}
	});
    }
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
    draw_status(0);
}

function feedback(type) {
    if (feedback_asking) {
	feedback_ask_done(null);
	if (type == "cancel")
	    return;
    }
    $.ajax({
	url: feedback_url + "feedback/" + type,
	type: "POST", dataType: "json", timeout: 3000,
	success: make_responder([feedback, type], set_status),
	error: manage_lease,
	xhrFields: {withCredentials: true}
    });
}

function feedback_ask() {
    $("#feedback_ask").height($("#feedback_stop").height());
    $("#feedback_ask .feedback_text").stop(true).fadeOut(250);
    $("#feedback_ask_entry").stop(true).fadeIn(250);
    $("#feedback_ask_q").focus();
    $("#feedback_ask_container").animate({width: Math.min($(window).width() - 10, $("#feedback_stop_container").width() * 2), height: $("#feedback_stop_container").height()}, {duration:250});
    feedback_asking = true;
}

function feedback_ask_ask() {
    var s;
    if ((s = $("#feedback_ask_q").val()))
	$.ajax({
	    url: feedback_url + "ask", data: {q: s},
	    type: "POST", dataType: "json", timeout: 3000,
	    success: make_responder(feedback_ask_ask, feedback_ask_done),
	    error: function () { feedback_ask_done(null); manage_lease(); },
	    xhrFields: {withCredentials: true}
	});
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
    $.ajax({
	url: feedback_url + "panel?poll=" + (boardstatus.updated_at || 0),
	type: "GET", dataType: "json",
	success: store_board,
	error: function () {
	    setTimeout(getboard, boardbackoff);
	    boardbackoff = Math.min(Math.max(boardbackoff * 2, 250), 30000);
	},
	xhrFields: {withCredentials: true}
    });
}

function store_board(data) {
    var i, q, qs, x;
    boardstatus = data;
    clock_offset = data.now - (new Date).getTime();

    x = {};
    for (i in boardqs)
	if (!(i in boardstatus.s))
	    x[i] = 1;
    for (i in x)
	delete boardqs[i];

    if ((qs = data.qs))
	for (i = 0; i < qs.length; ++i) {
	    q = qs[i];
	    x = boardqs[q[0]] = boardqs[q[0]] || [];
	    x.unshift([q[1], q[2]]);
	}

    draw_board(0);
    boardbackoff = 0;
    getboard();
}

function draw_board(from_timeout) {
    var e = $("#feedbackboard"), cv = e[0];
    if (!boardcolorre)
	boardcolorre = new RegExp("(?:aqua|black|blue|fuchsia|gray|grey|green|lime|maroon|navy|olive|purple|red|silver|teal|white|yellow|#[0-9a-f]{3}|#[0-9a-f]{6})", "i");

    // canvas-dependent sizes
    var cellsize = 30, xborder = 10, yborder = 10;
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
	emphasis_timeout = boardstatus.emphasis_timeout;
    var t_start, t_pulse, t_emphasis, t_hold, t_end;

    // drawing constants
    var ctx = cv.getContext("2d"),
	smallrad = cellsize / 10,
	qrad = smallrad * 2.5,
	largerad = smallrad * 4,
	maxrad = smallrad * 6,
	background = $.Color(232, 232, 242),
	swing = $.easing.swing;
    var i, j, s, ssize, sqs, r, x, y, overlap, f, fill, stroke;

    // restart animator
    board_animator = board_animator || new_animator(draw_board, 3);
    board_animator.clear(now, from_timeout);

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
	    if (s.emphasis > 1 && now < t_start + emphasis_timeout) {
		r = Math.min(maxrad, Math.sqrt(largerad * largerad * (s.emphasis + 1) / 2));
		r += swing((now - t_start) / emphasis_timeout) * (largerad - r);
		board_animator.update_at(now);
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
	    board_animator.update_at(now);
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

	if (f == "0" || now >= t_end) {
	    ctx.lineWidth = 0.5;
	    stroke = colors.board0.offborder;
	    fill = colors.board0.off;
	} else {
	    t_hold = t_start + hold_duration;
	    fill = colors[f].on;
	    stroke = colors[f].onborder;
	    if (f == "ask" && boardcolorre.test(sqs[0][1])) {
		fill = new $.Color(sqs[0][1]);
		stroke = fill.lightness("-=0.15");
	    }
	    if (now <= t_hold)
		ctx.lineWidth = 3;
	    else {
		x = swing((now - t_hold) / (t_end - t_hold));
		ctx.lineWidth = 3 - 2.5 * x;
		stroke = stroke.transition(colors.board0.offborder, x);
	    }
	    fill = colorat(now, board_animator,
			   t_start, fill,
			   t_hold, fill,
			   t_end, colors.board0.off);
	}

	if (overlap[i]) {
	    fill = fill.alpha(0.8);
	    stroke = stroke.alpha(0.8);
	}

	ctx.beginPath();
	x = ((i % nacross) + 0.5) * cellsize + xborder;
	y = (Math.floor(i / nacross) + 0.5) * cellsize + yborder;
	ctx.arc(x, y, boardsizes[i].r, 0, 7);
	ctx.fillStyle = fill.toRgbaString();
	ctx.fill();
	ctx.strokeStyle = stroke.toRgbaString();
	ctx.stroke();

	if (sqs && sqs[0][0] > now - duration && sqs[0][1] && f != "ask") {
	    ctx.beginPath();
	    ctx.arc(x, y, boardsizes[i].r / 2, 0, 7);
	    ctx.fillStyle = colors.ask.inset.toRgbaString();
	    ctx.fill();
	}
    }

    // done
    board_animator.go();
}

var window_width, window_height;
function resize_feedbackboard() {
    var p = $("#feedbackcontainer"), w$ = $(window),
	w = w$.width(), h = w$.height();
    if (window_width != w || window_height != h) {
	window_width = w;
	window_height = h;
	p.css({width: w, height: h});
	setTimeout(resize_feedbackboard, 1);
    } else {
	$("#feedbackboard").attr({width: w, height: h});
	draw_board(0);
    }
}

function unhover_board() {
    if (boardinfo.hovering >= 0) {
	boardinfo.hovering = -1;
	$("#feedbackhovertext").hide();
    }
}

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
    if (!(q = boardqs[i]))
	return null;
    xc = xb + (i % na + 0.5) * cs;
    yc = yb + (Math.floor(i / na) + 0.5) * cs;
    r = Math.sqrt((xc - x) * (xc - x) + (yc - y) * (yc - y));
    if (r > boardsizes[i].r + 2)
	return null;
    return [i, q[0][0]];
}

function hover_board(e) {
    var b = $("#feedbackboard"), p = b.offset(),
        bw = b.width(), bh = b.height(),
        x = e.pageX - p.left, y = e.pageY - p.top, t, b, body, i, j,
	hs = hover_board_status(x, y);
    if ((!hs && !boardinfo.hovers)
	|| (hs && boardinfo.hovers && hs[0] == boardinfo.hovers[0]
	    && hs[1] == boardinfo.hovers[1]))
	return;
    else if (!hs) {
	boardinfo.hovers = null;
	$(".feedbackhovertext").remove();
    } else {
	body = $(document);
	t = "<div class='feedbackhovertext' style='position:absolute;max-width:" +
	    bw + "px;";
	if (x < bw / 2)
	    t += "right:" + (body.width() - p.left - bw);
	else
	    t += "left:" + p.left;
	if (y < bh / 2)
	    t += "px;bottom:" + (body.height() - p.top - bh);
	else
	    t += "px;top:" + p.top;
	t = $(t + "px'></div>");

	b = boardqs[hs[0]];
	for (i = j = 0; j < 3 && i < b.length; ++i)
	    if (b[i][1]) {
		t.append($("<div></div>").text(b[i][1]));
		++j;
	    }
	t.appendTo($("body"));

	boardinfo.hovers = hs;
    }
}


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
    $("#feedbackboard").mousemove(hover_board);
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

})();
