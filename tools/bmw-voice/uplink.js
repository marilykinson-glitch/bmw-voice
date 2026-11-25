'use strict';
/**
 * uplink.js - Non-root HTTPS bridge for `bmw-voice` via MGU Store `mgu-uplink` (`v1.1.1`).
 *
 * Reliability upgrades for real-car MGU / phone-hotspot networks:
 *   1. Excludes BMW internal OABR/VLAN ethernet (`160.48.*`), link-local (`169.254.*`), and loopback (`127.*`)
 *      from DNS candidates so internal head-unit interfaces never return `queryA ECONNREFUSED`.
 *   2. Always includes `1.1.1.1` & `8.8.8.8` in the primary UDP DNS race pool alongside `lease.dns`.
 *   3. Automatic DNS-over-HTTPS (DoH) fallback over TCP port 443 (`1.1.1.1` Cloudflare & `8.8.8.8` Google by IP literal)
 *      whenever UDP port 53 is blocked or `ECONNREFUSED` by a phone hotspot / mobile carrier.
 *   4. Prewarms Keep-Alive TLS socket while the driver speaks, retries transient network resets once,
 *      and shuts down the helper worker after 90s idle (`0 MB RAM` when idle).
 *
 * Node 8 (ES2017) & Node 22 compatible.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const https = require('https');
const http = require('http');
const dns = require('dns');

const SELF = 'bmw-voice';
const MAX_UID = 60000;
const MAINAPPS = [
    { root: '/usr/lib/oap-mainapp', hmi: 'HmiMain3D' },
    { root: '/usr/lib/oap-mainapp21', hmi: 'Hmi8' },
];

const lines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n'); } catch (e) { return []; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const list = (d) => { try { return fs.readdirSync(d); } catch (e) { return []; } };
const isId = (n) => n > 0 && n === Math.floor(n);
const mkdirp = (d) => {
    if (fs.existsSync(d)) return;
    mkdirp(path.dirname(d));
    try { fs.mkdirSync(d); } catch (e) { if (e.code !== 'EEXIST') throw e; }
};

const NODE22_BIN = '/var/opt/jap-node22/current/bin/node';
const dnsCache = {};
const sharedHttpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 45000, maxSockets: 4 });
const insecureHttpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 45000, maxSockets: 2, rejectUnauthorized: false });

function clearDnsCache() {
    Object.keys(dnsCache).forEach((k) => { delete dnsCache[k]; });
}

function defaultFetchCmd() {
    if (fs.existsSync(NODE22_BIN)) {
        return [NODE22_BIN, '--max-http-header-size=65536', __filename, '--fetch'];
    }
    return [process.execPath, __filename, '--fetch'];
}

function workerCmdFromFetch(fetchCmd) {
    const arr = Array.isArray(fetchCmd) && fetchCmd.length >= 2 ? fetchCmd.slice() : defaultFetchCmd();
    arr[arr.length - 1] = '--worker';
    return arr;
}

function options(over) {
    return Object.assign({
        stateDir: '/var/opt/bmw-voice/state',
        etcDir: '/etc',
        oapRoot: '/var/opt/public/oap',
        toolRoot: '/var/opt',
        procDir: '/proc',
        mainapps: MAINAPPS,
        lease: '/run/mgu-uplink/lease.json',
        route: '/proc/net/route',
        fetchCmd: defaultFetchCmd(),
        noSetuid: false,
        baseUrl: '',
        dohEndpoints: null,
        log: () => {},
    }, over || {});
}

function mainappRanges(o) {
    const have = o.mainapps.filter((m) => fs.existsSync(path.join(m.root, 'config', 'base.json')));
    let m = have.length === 1 ? have[0] : null;
    if (have.length > 1) {
        const running = list(o.procDir).filter((n) => /^\d+$/.test(n)).map((n) => (lines(path.join(o.procDir, n, 'comm'))[0] || '').trim());
        const which = have.filter((x) => running.indexOf(x.hmi) >= 0);
        m = which.length === 1 ? which[0] : null;
    }
    const c = m && readJson(path.join(m.root, 'config', 'base.json'));
    if (!c) return null;
    const rse = c.usableUidsAndGidsRse || {};
    const ranges = [c.usableUidsAndGids].concat(Object.keys(rse).map((k) => rse[k]))
        .filter((r) => r && isId(Number(r.min)) && Number(r.max) >= Number(r.min))
        .map((r) => ({ min: Number(r.min), max: Number(r.max) }));
    return ranges.length ? { ranges, own: (Array.isArray(c.mainAppUids) ? c.mainAppUids : []).map(Number).filter(isId) } : null;
}

function takenIds(o, cfg, procs) {
    const ids = {};
    const add = (v) => { const n = Number(v); if (String(v).trim() !== '' && isId(n)) ids[n] = true; };
    lines(path.join(o.etcDir, 'passwd')).forEach((l) => { const f = l.split(':'); add(f[2] || ''); add(f[3] || ''); });
    lines(path.join(o.etcDir, 'group')).forEach((l) => add(l.split(':')[2] || ''));
    list(o.oapRoot).forEach((n) => { const m = /^oap_(\d+)$/.exec(n); if (m) add(m[1]); });
    const mgr = path.join(o.oapRoot, 'oap_12201');
    list(path.join(mgr, 'data', 'apps')).forEach((n) => {
        const e = readJson(path.join(mgr, 'data', 'apps', n));
        add(e && e.userId !== undefined ? e.userId : '');
    });
    lines(path.join(mgr, 'security', 'uids.txt')).forEach((l) => add(l.split('=')[0]));
    const dropins = path.join(o.toolRoot, 'mgu-uplink', 'uids.d');
    list(dropins).filter((n) => n !== SELF && !/^\./.test(n)).forEach((n) =>
        lines(path.join(dropins, n)).forEach((l) => l.split('#')[0].split(/[\s,]+/).forEach(add)));
    const upd = readJson(path.join(o.toolRoot, 'mgu-updater', 'state', 'uids.json')) || {};
    Object.keys(upd).forEach((k) => add(upd[k]));
    (cfg ? cfg.own : []).forEach(add);
    if (procs) {
        list(o.procDir).filter((n) => /^\d+$/.test(n)).forEach((pid) => lines(path.join(o.procDir, pid, 'status')).forEach((l) => {
            const m = /^[UG]id:\s+(.*)$/.exec(l);
            if (m) m[1].split(/\s+/).forEach(add);
        }));
    }
    return ids;
}

function writeIfChanged(file, text, mode) {
    try { if (fs.readFileSync(file, 'utf8') === text) return; } catch (e) { /* create */ }
    fs.writeFileSync(file + '.tmp', text, { mode });
    fs.renameSync(file + '.tmp', file);
}

function pickUid(o) {
    if (o && isId(o._cachedUid)) return o._cachedUid;
    const kept = Number((readJson(path.join(o.stateDir, 'uids.json')) || {}).fetch);
    const cfg = mainappRanges(o);
    const inRange = (u) => !!cfg && cfg.ranges.some((r) => u >= r.min && u <= r.max);
    let uid = null;
    if (isId(kept) && !takenIds(o, cfg, false)[kept] && !inRange(kept)) uid = kept;
    else if (cfg) {
        const all = takenIds(o, cfg, true);
        let u = Math.max.apply(null, cfg.ranges.map((r) => r.max)) + 1;
        while (u <= MAX_UID && (all[u] || inRange(u))) u++;
        if (u <= MAX_UID) { uid = u; o.log('internet uid: ' + u); }
    }
    if (uid === null) return null;
    if (!fs.existsSync(o.stateDir)) { mkdirp(path.dirname(o.stateDir)); fs.mkdirSync(o.stateDir, 0o700); }
    writeIfChanged(path.join(o.stateDir, 'uids.json'), JSON.stringify({ fetch: uid }) + '\n', 0o644);
    writeIfChanged(path.join(o.stateDir, 'internet-uids'), uid + '\n', 0o644);
    const uplink = path.join(o.toolRoot, 'mgu-uplink');
    if (fs.existsSync(path.join(uplink, 'current')) || fs.existsSync(path.join(uplink, 'uids.d'))) {
        try { mkdirp(path.join(uplink, 'uids.d')); writeIfChanged(path.join(uplink, 'uids.d', SELF), uid + '\n', 0o644); } catch (e) {}
    }
    if (o) o._cachedUid = uid;
    return uid;
}

function isUsableDnsIp(ip) {
    if (typeof ip !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
    if (ip === '0.0.0.0' || ip === '255.255.255.255') return false;
    // Exclude loopback (`127.*`), link-local (`169.254.*`), and BMW MGU internal OABR/VLAN (`160.48.*`)
    if (/^(?:127\.|169\.254\.|160\.48\.)/.test(ip)) return false;
    const parts = ip.split('.').map(Number);
    return parts.every((n) => n >= 0 && n <= 255);
}

function dnsServers(leaseFile, routeFile) {
    const out = [];
    const add = (ip) => {
        if (isUsableDnsIp(ip) && out.indexOf(ip) < 0) out.push(ip);
    };
    const lease = readJson(leaseFile || '/run/mgu-uplink/lease.json') || {};
    (lease.dns || []).forEach(add);
    // Keep public anycast DNS inside the primary race pool so dead local resolvers never starve lookup
    ['1.1.1.1', '8.8.8.8'].forEach(add);
    ['/run/connman/resolv.conf', '/var/run/connman/resolv.conf', '/etc/resolv.conf'].forEach((f) => {
        lines(f).forEach((l) => { const m = /^\s*nameserver\s+(\S+)/.exec(l); if (m) add(m[1]); });
    });
    lines(routeFile || '/proc/net/route').slice(1)
        .map((l) => l.trim().split(/\s+/))
        .filter((c) => c.length > 7 && c[1] === '00000000' && c[7] === '00000000')
        .forEach((c) => {
            const g = parseInt(c[2], 16);
            if (isFinite(g)) add([g & 255, (g >>> 8) & 255, (g >>> 16) & 255, (g >>> 24) & 255].join('.'));
        });
    return out;
}

const DEFAULT_DOH_ENDPOINTS = [
    { proto: 'https', ip: '1.1.1.1', port: 443, servername: 'cloudflare-dns.com', hostHeader: 'cloudflare-dns.com', pathPrefix: '/dns-query' },
    { proto: 'https', ip: '8.8.8.8', port: 443, servername: 'dns.google', hostHeader: 'dns.google', pathPrefix: '/resolve' },
];

function querySingleDoh(ep, host, timeoutMs, strictTls) {
    return new Promise((resolve, reject) => {
        let done = false;
        const fin = (err, ips) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (err) reject(err);
            else resolve(ips);
        };
        const isHttp = ep.proto === 'http';
        const transport = isHttp ? http : https;
        const qPath = ep.pathPrefix + '?name=' + encodeURIComponent(host) + '&type=A';
        const reqOpts = {
            host: ep.ip,
            port: ep.port || (isHttp ? 80 : 443),
            path: qPath,
            method: 'GET',
            headers: {
                Host: ep.hostHeader || ep.ip,
                Accept: 'application/dns-json',
                'User-Agent': 'bmw-voice/1.1',
                Connection: 'keep-alive',
            },
        };
        if (!isHttp) {
            reqOpts.servername = ep.servername || ep.hostHeader || ep.ip;
            reqOpts.family = 4;
            reqOpts.rejectUnauthorized = strictTls !== false;
            reqOpts.agent = strictTls !== false ? sharedHttpsAgent : insecureHttpsAgent;
        }
        const req = transport.request(reqOpts, (res) => {
            const chunks = [];
            let sz = 0;
            res.on('data', (c) => {
                sz += c.length;
                if (sz > 65536) { req.abort(); fin(new Error('DoH response too large')); return; }
                chunks.push(c);
            });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return fin(new Error('DoH HTTP ' + res.statusCode));
                }
                try {
                    const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    const ans = Array.isArray(j && j.Answer) ? j.Answer : [];
                    const ips = [];
                    for (let i = 0; i < ans.length; i++) {
                        const a = ans[i];
                        if (a && (a.type === 1 || a.type === 'A') && typeof a.data === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(a.data)) {
                            if (ips.indexOf(a.data) < 0) ips.push(a.data);
                        }
                    }
                    if (!ips.length) return fin(new Error('DoH no A record'));
                    fin(null, ips);
                } catch (e) {
                    fin(e);
                }
            });
            res.on('error', fin);
        });
        const timer = setTimeout(() => { try { req.abort(); } catch (e) {} fin(new Error('DoH timeout')); }, timeoutMs || 2400);
        req.on('error', (err) => {
            const msg = String((err && err.code) || '') + ' ' + String((err && err.message) || '');
            if (!isHttp && strictTls !== false && /CERT|TLS|SSL|UNABLE_TO_VERIFY|SELF_SIGNED/i.test(msg)) {
                done = true;
                clearTimeout(timer);
                querySingleDoh(ep, host, timeoutMs, false).then(resolve, reject);
                return;
            }
            fin(err);
        });
        req.end();
    });
}

function resolveViaDoh(host, dohEndpoints, timeoutMs) {
    const eps = Array.isArray(dohEndpoints) && dohEndpoints.length ? dohEndpoints : DEFAULT_DOH_ENDPOINTS;
    return new Promise((resolve, reject) => {
        let settled = false;
        let pending = eps.length;
        let lastErr = null;
        eps.forEach((ep) => {
            querySingleDoh(ep, host, timeoutMs || 2400, true).then(
                (ips) => {
                    if (settled) return;
                    settled = true;
                    resolve(ips);
                },
                (err) => {
                    lastErr = err || lastErr;
                    pending--;
                    if (!settled && pending <= 0) {
                        settled = true;
                        reject(lastErr || new Error('DoH failed for ' + host));
                    }
                }
            );
        });
    });
}

function customLookup(leaseFile, routeFile, preResolvedServers, dohEndpoints) {
    const servers = Array.isArray(preResolvedServers) && preResolvedServers.length
        ? preResolvedServers.filter(isUsableDnsIp)
        : dnsServers(leaseFile, routeFile);
    if (!servers.length) {
        servers.push('1.1.1.1', '8.8.8.8');
    }
    return function (host, opts, cb) {
        if (typeof opts === 'function') {
            cb = opts;
            opts = {};
        }
        const wantAll = !!(opts && opts.all);
        const deliver = (ips) => {
            if (wantAll) {
                return cb(null, ips.map((address) => ({ address, family: 4 })));
            }
            return cb(null, ips[0], 4);
        };
        if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return deliver([host]);

        const now = Date.now();
        const cached = dnsCache[host];
        if (cached && cached.expiresAt > now && cached.ips && cached.ips.length) {
            return deliver(cached.ips);
        }

        const pool = servers.slice(0, 5);
        let settled = false;
        let pending = pool.length;
        let lastErr = null;
        const timers = [];

        const tryDohFallback = () => {
            if (dohEndpoints === false) {
                cb(lastErr || new Error('DNS failed for ' + host));
                return;
            }
            resolveViaDoh(host, dohEndpoints, 2500).then(
                (ips) => {
                    dnsCache[host] = { ips, expiresAt: Date.now() + 600000 };
                    deliver(ips);
                },
                () => {
                    cb(lastErr || new Error('DNS failed for ' + host));
                }
            );
        };

        const finishErr = (err) => {
            lastErr = err || lastErr;
            pending--;
            if (!settled && pending <= 0) {
                settled = true;
                timers.forEach(clearTimeout);
                tryDohFallback();
            }
        };

        pool.forEach((srv, idx) => {
            const launch = () => {
                if (settled) return;
                const r = new dns.Resolver();
                try { r.setServers([srv]); } catch (e) { return finishErr(e); }
                let localDone = false;
                const t = setTimeout(() => {
                    if (!localDone) {
                        localDone = true;
                        finishErr(new Error('DNS timeout'));
                    }
                }, 1600);
                timers.push(t);
                r.resolve4(host, (err, ips) => {
                    if (localDone || settled) return;
                    localDone = true;
                    clearTimeout(t);
                    if (err || !ips || !ips.length) return finishErr(err || new Error('no A record'));
                    settled = true;
                    timers.forEach(clearTimeout);
                    dnsCache[host] = { ips, expiresAt: Date.now() + 600000 };
                    deliver(ips);
                });
            };
            if (idx < 3) launch();
            else timers.push(setTimeout(launch, 55));
        });
    };
}

function doHttp(q, lookup, strictTls) {
    return new Promise((resolve, reject) => {
        let done = false, size = 0;
        const finish = (e, v) => { if (done) return; done = true; clearTimeout(timer); e ? reject(e) : resolve(v); };
        const bodyBuf = q.bodyBase64 ? Buffer.from(q.bodyBase64, 'base64') : (q.body ? Buffer.from(String(q.body), 'utf8') : null);
        const headers = Object.assign({ 'User-Agent': 'bmw-voice/1.1', Accept: 'application/json', Connection: 'keep-alive' }, q.headers || {});
        if (bodyBuf) headers['Content-Length'] = bodyBuf.length;

        let transport = https;
        let reqOpts;
        if (q.baseUrl) {
            const m = /^http:\/\/([^:/]+):(\d+)/.exec(q.baseUrl);
            transport = http;
            reqOpts = {
                host: m ? m[1] : '127.0.0.1',
                port: m ? Number(m[2]) : 80,
                path: String(q.path),
                method: q.method || (bodyBuf ? 'POST' : 'GET'),
                headers,
            };
        } else {
            reqOpts = {
                host: String(q.host),
                servername: String(q.host),
                family: 4,
                autoSelectFamily: false,
                path: String(q.path),
                method: q.method || (bodyBuf ? 'POST' : 'GET'),
                headers,
                lookup,
                agent: strictTls !== false ? sharedHttpsAgent : insecureHttpsAgent,
                rejectUnauthorized: strictTls !== false,
            };
        }

        const req = transport.request(reqOpts, (res) => {
            const chunks = [];
            res.on('data', (c) => {
                size += c.length;
                if (size > 6e6) { req.abort(); finish(new Error('response too large')); return; }
                chunks.push(c);
            });
            res.on('end', () => {
                const raw = Buffer.concat(chunks);
                finish(null, { status: res.statusCode, body: raw.toString('utf8') });
            });
            res.on('error', finish);
        });
        const timer = setTimeout(() => { req.abort(); finish(new Error('timeout')); }, q.timeoutMs || 18000);
        req.on('error', finish);
        if (bodyBuf) req.write(bodyBuf);
        req.end();
    });
}

function doHttpWithTlsFallback(q, lookup) {
    const attempt = () => doHttp(q, lookup, true).catch((err) => {
        const msg = String((err && err.code) || '') + ' ' + String((err && err.message) || '');
        if (/CERT|TLS|SSL|UNABLE_TO_VERIFY|SELF_SIGNED/i.test(msg) && !q.baseUrl) {
            return doHttp(q, lookup, false);
        }
        throw err;
    });

    return attempt().catch((err) => {
        const msg = String((err && err.code) || '') + ' ' + String((err && err.message) || '');
        if (!q.baseUrl && /ECONNREFUSED|ECONNRESET|EPIPE|EAI_AGAIN|ENETUNREACH|DNS/i.test(msg)) {
            if (q.host) delete dnsCache[q.host];
            return new Promise((r) => setTimeout(r, 150)).then(attempt);
        }
        throw err;
    });
}

function prewarmHost(host, lookup) {
    return new Promise((resolve) => {
        if (!host || !/^[a-z0-9.-]+$/i.test(host)) return resolve(false);
        let done = false;
        const fin = (ok) => { if (!done) { done = true; clearTimeout(t); resolve(ok); } };
        const req = https.request({
            host: String(host),
            servername: String(host),
            family: 4,
            autoSelectFamily: false,
            path: '/',
            method: 'HEAD',
            headers: { Connection: 'keep-alive', 'User-Agent': 'bmw-voice/1.1' },
            lookup,
            agent: sharedHttpsAgent,
        }, (res) => {
            res.resume();
            res.on('end', () => fin(true));
        });
        const t = setTimeout(() => { try { req.abort(); } catch (e) {} fin(false); }, 3000);
        req.on('error', () => fin(false));
        req.end();
    });
}

function ensurePersistentWorker(o, uid) {
    if (o._worker && o._worker.child && !o._worker.dead) {
        return o._worker;
    }
    const cmd = workerCmdFromFetch(o.fetchCmd);
    let child;
    try {
        child = cp.spawn(cmd[0], cmd.slice(1), {
            uid, gid: uid, cwd: '/', env: {}, stdio: ['pipe', 'pipe', 'ignore'],
        });
    } catch (e) {
        return null;
    }
    if (typeof child.unref === 'function') child.unref();
    const state = {
        child,
        dead: false,
        seq: 0,
        pending: {},
        buf: '',
        idleTimer: null,
    };
    const resetIdle = () => {
        if (state.idleTimer) clearTimeout(state.idleTimer);
        state.idleTimer = setTimeout(() => {
            if (!state.dead && Object.keys(state.pending).length === 0) {
                state.dead = true;
                if (o._worker === state) o._worker = null;
                try { child.kill('SIGTERM'); } catch (e) {}
            }
        }, 90000);
        if (state.idleTimer && typeof state.idleTimer.unref === 'function') state.idleTimer.unref();
    };
    resetIdle();
    state.resetIdle = resetIdle;
    const failAll = (err) => {
        if (state.dead) return;
        state.dead = true;
        if (state.idleTimer) { clearTimeout(state.idleTimer); state.idleTimer = null; }
        if (o._worker === state) o._worker = null;
        const pendingMap = state.pending;
        state.pending = {};
        Object.keys(pendingMap).forEach((k) => {
            const p = pendingMap[k];
            if (p) { clearTimeout(p.timer); p.reject(err); }
        });
    };
    child.on('error', (e) => failAll(e));
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk) => {
        state.buf += chunk.toString('utf8');
        let idx;
        while ((idx = state.buf.indexOf('\n')) >= 0) {
            const line = state.buf.slice(0, idx).trim();
            state.buf = state.buf.slice(idx + 1);
            if (!line) continue;
            let msg = null;
            try { msg = JSON.parse(line); } catch (e) {}
            if (!msg || !msg.id) continue;
            const waiter = state.pending[msg.id];
            if (!waiter) continue;
            delete state.pending[msg.id];
            clearTimeout(waiter.timer);
            if (msg.error) waiter.reject(new Error(msg.error));
            else waiter.resolve(msg.res);
        }
    });
    child.on('close', () => {
        const pendingMap = state.pending;
        state.pending = {};
        state.dead = true;
        if (o._worker === state) o._worker = null;
        Object.keys(pendingMap).forEach((k) => {
            clearTimeout(pendingMap[k].timer);
            pendingMap[k].reject(new Error('uplink worker closed'));
        });
    });
    o._worker = state;
    return state;
}

function request(o, reqSpec) {
    if (o.baseUrl) {
        return doHttpWithTlsFallback(Object.assign({}, reqSpec, { baseUrl: o.baseUrl }), undefined);
    }
    const uid = pickUid(o);
    if (uid === null || o.noSetuid) {
        return doHttpWithTlsFallback(reqSpec, customLookup(o.lease, o.route, undefined, o.dohEndpoints));
    }
    const worker = ensurePersistentWorker(o, uid);
    if (!worker) {
        return Promise.reject(new Error('cannot start uplink worker'));
    }
    if (worker.resetIdle) worker.resetIdle();
    return new Promise((resolve, reject) => {
        const id = ++worker.seq;
        const timer = setTimeout(() => {
            if (worker.pending[id]) {
                delete worker.pending[id];
                reject(new Error('uplink timeout'));
            }
        }, (reqSpec.timeoutMs || 18000) + 2500);
        worker.pending[id] = {
            timer,
            resolve: (r) => resolve({
                status: r.status,
                body: r.body !== undefined ? String(r.body) : '',
            }),
            reject,
        };
        const servers = dnsServers(o.lease, o.route);
        const payload = Object.assign({}, reqSpec, {
            lease: o.lease,
            route: o.route,
            dns: servers,
            dohEndpoints: o.dohEndpoints || null,
        });
        try {
            worker.child.stdin.write(JSON.stringify({ id, q: payload }) + '\n');
        } catch (e) {
            clearTimeout(timer);
            delete worker.pending[id];
            reject(e);
        }
    });
}

function warmup(o) {
    const listHosts = ['generativelanguage.googleapis.com'];
    if (!o || o.baseUrl) return Promise.resolve(false);
    const uid = pickUid(o);
    if (uid === null || o.noSetuid) {
        const lk = customLookup(o.lease, o.route, undefined, o.dohEndpoints);
        return Promise.all(listHosts.map((h) => prewarmHost(h, lk))).then(() => true, () => false);
    }
    const worker = ensurePersistentWorker(o, uid);
    if (!worker) return Promise.resolve(false);
    if (worker.resetIdle) worker.resetIdle();
    return new Promise((resolve) => {
        const id = ++worker.seq;
        const timer = setTimeout(() => {
            delete worker.pending[id];
            resolve(false);
        }, 3500);
        worker.pending[id] = {
            timer,
            resolve: () => resolve(true),
            reject: () => resolve(false),
        };
        const servers = dnsServers(o.lease, o.route);
        try {
            worker.child.stdin.write(JSON.stringify({
                id,
                warmup: listHosts,
                lease: o.lease,
                route: o.route,
                dns: servers,
                dohEndpoints: o.dohEndpoints || null,
            }) + '\n');
        } catch (e) {
            clearTimeout(timer);
            delete worker.pending[id];
            resolve(false);
        }
    });
}

function close(o) {
    if (o && o._worker && o._worker.child) {
        const c = o._worker.child;
        if (o._worker.idleTimer) clearTimeout(o._worker.idleTimer);
        o._worker.dead = true;
        o._worker = null;
        try { c.kill('SIGTERM'); } catch (e) {}
    }
}

if (require.main === module && process.argv[2] === '--worker') {
    process.on('uncaughtException', () => {});
    process.on('unhandledRejection', () => {});
    let inBuf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
        inBuf += chunk;
        let idx;
        while ((idx = inBuf.indexOf('\n')) >= 0) {
            const line = inBuf.slice(0, idx).trim();
            inBuf = inBuf.slice(idx + 1);
            if (!line) continue;
            let msg;
            try { msg = JSON.parse(line); } catch (e) { continue; }
            const id = msg && msg.id;
            if (!id) continue;
            if (Array.isArray(msg.warmup)) {
                const lk = customLookup(msg.lease, msg.route, msg.dns, msg.dohEndpoints);
                Promise.all(msg.warmup.map((h) => prewarmHost(h, lk)))
                    .then(
                        () => process.stdout.write(JSON.stringify({ id, res: { ok: true } }) + '\n'),
                        () => process.stdout.write(JSON.stringify({ id, res: { ok: false } }) + '\n')
                    );
                continue;
            }
            const q = msg.q || {};
            if (!/^[a-z0-9.-]+$/i.test(String(q.host)) || String(q.path).charAt(0) !== '/') {
                process.stdout.write(JSON.stringify({ id, error: 'bad host/path' }) + '\n');
                continue;
            }
            doHttpWithTlsFallback(q, customLookup(q.lease, q.route, q.dns, q.dohEndpoints))
                .then(
                    (res) => process.stdout.write(JSON.stringify({ id, res }) + '\n'),
                    (e) => process.stdout.write(JSON.stringify({ id, error: e.code ? e.code + ' ' + e.message : e.message }) + '\n')
                );
        }
    });
    process.stdin.on('end', () => process.exit(0));
} else if (require.main === module && process.argv[2] === '--fetch') {
    process.on('uncaughtException', () => process.exit(0));
    process.on('unhandledRejection', () => process.exit(0));
    const chunks = [];
    const out = (o) => process.stdout.write(JSON.stringify(o), () => process.exit(0));
    process.stdin.on('data', (d) => chunks.push(d));
    process.stdin.on('end', () => {
        let q;
        try { q = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return out({ error: 'bad request' }); }
        if (!/^[a-z0-9.-]+$/i.test(String(q.host)) || String(q.path).charAt(0) !== '/') return out({ error: 'bad host/path' });
        doHttpWithTlsFallback(q, customLookup(q.lease, q.route, q.dns, q.dohEndpoints))
            .then(out, (e) => out({ error: e.code ? e.code + ' ' + e.message : e.message }));
    });
}

module.exports = {
    SELF,
    options,
    pickUid,
    isUsableDnsIp,
    dnsServers,
    resolveViaDoh,
    clearDnsCache,
    customLookup,
    request,
    warmup,
    close,
};
