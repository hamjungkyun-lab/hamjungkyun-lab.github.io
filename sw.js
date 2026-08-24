/*
 * 서비스 워커 — 껍데기를 기기에 남겨 둔다.
 *
 * ★ 왜 두는가.
 *   이 앱의 데이터는 이미 전부 localStorage 에 있다. 그런데 화면을 그리는
 *   코드가 매번 네트워크에서 와서, 신호가 약한 곳에서는 내 기기에 있는
 *   내 기록조차 못 열었다. 산부인과 대기실·엘리베이터·새벽의 방이 그렇다.
 *
 * ★ 데이터는 여기서 다루지 않는다.
 *   저장하는 것은 화면 조각(HTML·JS·CSS)뿐이다. 기록과 선택은 그대로
 *   localStorage 에 있고, 이 파일은 그것을 읽지도 보내지도 않는다.
 *
 * ★ 화면은 언제나 네트워크를 먼저 본다.
 *   저장해 둔 것을 먼저 내주면 고친 화면이 며칠씩 안 바뀐다.
 *   연결이 있으면 새것을, 없을 때만 저장해 둔 것을 준다.
 *
 * 판을 바꿀 때는 VERSION 을 올린다. 옛 판은 다음 실행에서 지워진다.
 */

const VERSION = 'v26'
const SHELL = `parentway-shell-${VERSION}` // 화면(HTML)
const ASSETS = `parentway-assets-${VERSION}` // /_next/static — 이름에 해시가 있어 안 바뀐다
const KEEP = [SHELL, ASSETS]

/*
 * 미리 받아 두는 화면.
 *
 * ★ 설치한 그날 바로 비행기 모드가 되어도 열려야 한다.
 *   첫 방문은 서비스 워커가 서기 전에 끝나서, 그때 받은 것은 여기에 없다.
 *   그래서 설치하는 김에 한 번 더 받아 둔다.
 *
 * 급할 때 여는 것만 넣는다 — 나머지 화면은 한 번 열어 보면 그때 남는다.
 */
// 홈 타일이 가리키는 화면은 전부 담는다 — 대기실에서 신호가 끊겼을 때
// 타일을 눌렀는데 홈이 다시 뜨면 '앱이 먹통'으로 읽힌다.
const PRECACHE = ['/', '/search', '/diary', '/notes', '/play', '/record', '/summary',
  '/today', '/approach', '/choices', '/past', '/report', '/quiz', '/quiz/result', '/start']

/** HTML 안에서 이 화면이 쓰는 조각들을 찾아낸다. 이름은 빌드할 때마다 바뀐다. */
function assetsIn(html) {
  const found = new Set()
  const re = /\/_next\/static\/[^"'\s\\>]+?\.(?:js|css)/g
  let m
  while ((m = re.exec(html)) !== null) found.add(m[0])
  return [...found]
}

async function precache() {
  const shell = await caches.open(SHELL)
  const assets = await caches.open(ASSETS)

  await Promise.all(
    PRECACHE.map(async (path) => {
      try {
        const res = await fetch(path, { cache: 'reload' })
        if (!res.ok) return
        const html = await res.clone().text()
        await shell.put(path, res)
        // 조각 하나가 실패해도 나머지는 남긴다 — 다 아니면 아무것도 아닌 것이 되지 않게
        await Promise.all(assetsIn(html).map((u) => assets.add(u).catch(() => {})))
      } catch {
        /* 설치 중에 연결이 끊길 수 있다. 그때는 다음 방문에 저절로 채워진다. */
      }
    }),
  )
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(
        names.filter((n) => n.startsWith('parentway-') && !KEEP.includes(n)).map((n) => caches.delete(n)),
      )
      await self.clients.claim()
    })(),
  )
})

/* ── 가져오는 방법 세 가지 ───────────────────────── */

/** 화면 — 네트워크 먼저, 안 되면 저장해 둔 것, 그것도 없으면 아래 안내. */
async function navigate(request) {
  const shell = await caches.open(SHELL)
  try {
    const fresh = await fetch(request)
    if (fresh.ok && fresh.type === 'basic') shell.put(request, fresh.clone())
    return fresh
  } catch {
    const hit = await shell.match(request, { ignoreSearch: true })
    if (hit) return hit
    // 이 화면은 없어도 대시보드는 대개 있다. 위험 신호 목록이 거기에 있다.
    const home = await shell.match('/')
    if (home) return home
    return new Response(OFFLINE, {
      status: 503,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  }
}

/** 조각 — 이름에 해시가 있으니 한 번 받으면 다시 받을 이유가 없다. */
async function immutable(request) {
  const cache = await caches.open(ASSETS)
  const hit = await cache.match(request)
  if (hit) return hit
  const res = await fetch(request)
  if (res.ok && res.type === 'basic') cache.put(request, res.clone())
  return res
}

/** 나머지(아이콘·manifest) — 네트워크 먼저, 없으면 저장해 둔 것. */
async function passthrough(request) {
  const cache = await caches.open(ASSETS)
  try {
    const res = await fetch(request)
    if (res.ok && res.type === 'basic') cache.put(request, res.clone())
    return res
  } catch {
    const hit = await cache.match(request)
    if (hit) return hit
    throw new Error('offline')
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return // 남의 집 것은 손대지 않는다

  /*
   * ★ 라우터가 부르는 조각(_rsc)은 저장하지 않는다.
   *   판이 바뀐 뒤에도 옛 조각을 내주면 없는 파일을 가리키게 되고, 화면이
   *   깨진 채로 남는다. 연결이 없으면 이 요청은 그냥 실패하고, 그때 라우터가
   *   주소를 통째로 다시 여는 쪽으로 물러선다 — 그 길은 위의 navigate 가 받는다.
   */
  if (url.searchParams.has('_rsc')) return

  if (request.mode === 'navigate') {
    event.respondWith(navigate(request))
    return
  }

  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(immutable(request))
    return
  }

  if (url.pathname.startsWith('/_next/')) return // 나머지 내부 통신은 건드리지 않는다

  event.respondWith(passthrough(request))
})

/*
 * 저장해 둔 것이 하나도 없을 때만 보이는 화면.
 * 앱이 자기를 설명하지 않는다 — 지금 무슨 일인지와 무엇을 하면 되는지만.
 */
const OFFLINE = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>참교육</title>
<style>
  :root { color-scheme: light dark; --page:#FCFAF6; --ink:#191722; --mut:#6B6560; }
  @media (prefers-color-scheme: dark) {
    :root { --page:#131219; --ink:#F3F1F8; --mut:#8E8AA0; }
  }
  body { margin:0; min-height:100dvh; display:flex; align-items:center; justify-content:center;
         background:var(--page); color:var(--ink); padding:24px;
         font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,'Noto Sans KR','Malgun Gothic',sans-serif; }
  main { max-width:22rem; text-align:center; }
  h1 { margin:0; font-size:20px; font-weight:800; }
  p { margin:10px 0 0; font-size:14px; line-height:1.7; color:var(--mut); }
  button { margin-top:24px; padding:14px 24px; border:0; border-radius:999px;
           background:#6B5BFF; color:#fff; font-size:14.5px; font-weight:700; }
</style>
</head>
<body>
  <main>
    <h1>연결이 끊겨 있어요</h1>
    <p>이 화면은 아직 기기에 남아 있지 않아요.<br>연결되면 다시 열어 드릴게요.</p>
    <button onclick="location.reload()">다시 시도</button>
  </main>
</body>
</html>`


/* ── 매일 알림 ─────────────────────────────────────
 *
 * ★ 사용자가 화면에서 켠 것만 울린다.
 *   설정은 화면이 postMessage 로 넘겨 주고(워커는 localStorage 를 못 읽는다),
 *   여기 IndexedDB 에 담아 둔다. 하루 한 번, 정한 시각 '이후 즈음'.
 * ★ 빚을 만들지 않는다 — "며칠째 안 오셨어요" 같은 말은 없다.
 */
const KV_DB = 'parentway-sw'

function kvStore(mode, run) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(KV_DB, 1)
    open.onupgradeneeded = () => open.result.createObjectStore('kv')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction('kv', mode)
      const req = run(tx.objectStore('kv'))
      tx.oncomplete = () => {
        db.close()
        resolve(req && req.result)
      }
      tx.onerror = () => {
        db.close()
        reject(tx.error)
      }
    }
  })
}
const kvGet = (k) => kvStore('readonly', (st) => st.get(k)).catch(() => undefined)
const kvSet = (k, v) => kvStore('readwrite', (st) => st.put(v, k)).catch(() => undefined)

self.addEventListener('message', (e) => {
  const d = e.data
  if (d && d.type === 'reminder') {
    e.waitUntil ? e.waitUntil(kvSet('reminder', { on: d.on, hour: d.hour })) : kvSet('reminder', { on: d.on, hour: d.hour })
  }
})

async function maybeNotify() {
  const pref = await kvGet('reminder')
  if (!pref || !pref.on) return
  const now = new Date()
  // 정한 시각 전이면 이번 깨어남은 넘긴다 — 다음 깨어남이 그 뒤에 온다
  if (now.getHours() < pref.hour) return
  const today = now.toDateString()
  if ((await kvGet('reminderShown')) === today) return
  await kvSet('reminderShown', today)
  await self.registration.showNotification('참교육', {
    body: '오늘 것이 하나 준비돼 있어요. 잠깐 볼까요?',
    icon: '/apple-icon.png',
    badge: '/apple-icon.png',
    tag: 'daily-reminder',
  })
}

self.addEventListener('periodicsync', (e) => {
  if (e.tag === 'daily-reminder') e.waitUntil(maybeNotify())
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) if ('focus' in c) return c.focus()
      return self.clients.openWindow('/')
    }),
  )
})
