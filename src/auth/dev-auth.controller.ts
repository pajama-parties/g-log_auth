import { Controller, Get, HttpCode, Inject, NotFoundException, Post, Req, Res } from '@nestjs/common';
import { Public } from '@nestjs/authentication';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { AuthConfig } from '../config/auth.config.js';
import { AUTH_CONFIG } from './auth.constants.js';
import { issueKakaoState } from './kakao-state.js';

/** 카카오 JavaScript SDK (공식 CDN) */
const KAKAO_SDK_URL = 'https://t1.kakaocdn.net/kakao_js_sdk/2.7.2/kakao.min.js';

/**
 * (임시·개발용) 로그인 상태 확인 + 카카오 로그인(JavaScript SDK) / 이메일 코드 로그인 / 로그아웃 페이지.
 * http://localhost:3000/auth/dev — 운영(NODE_ENV=production)에서는 404.
 *
 * SDK의 Kakao.Auth.authorize()가 인가 코드를 받아 기존 콜백(/auth/kakao/callback)으로 보내므로
 * 서버 쪽 토큰 교환·JWT 발급 로직은 그대로 사용한다.
 */
@ApiExcludeController()
@Public()
@Controller('auth/dev')
export class DevAuthController {
  constructor(
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    private readonly env: ConfigService,
  ) {}

  @Get()
  page(@Req() req: Request, @Res() res: Response) {
    if (this.config.secureCookies) throw new NotFoundException();
    const { javascriptKey, redirectUri, forceLogin } = this.config.kakao;
    // state 쿠키는 호스트별이라 127.0.0.1 에서 열면 localhost 콜백에 실려 가지 않음 → Redirect URI 호스트로 맞춤
    const callbackHost = new URL(redirectUri).host;
    if (req.headers.host !== callbackHost) {
      res.redirect(new URL('/auth/dev', redirectUri).toString());
      return;
    }
    res
      .set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      .send(
        renderPage({
          javascriptKey: javascriptKey ?? null,
          redirectUri,
          forceLogin,
          // SMTP 설정이 없으면 메일 대신 서버 로그에 코드가 찍힘 (mail.config.ts)
          mailToLog: !this.env.get<string>('SMTP_USER'),
        }),
      );
  }

  /**
   * 로그인 버튼을 누를 때 state 발급 (POST /api/auth/dev/state).
   * 페이지를 열 때 발급하면 다른 탭·10분 경과로 쿠키가 바뀌거나 만료돼 콜백에서 "만료" 처리됨.
   */
  @Post('state')
  @HttpCode(200)
  state(@Res({ passthrough: true }) res: Response): { state: string } {
    if (this.config.secureCookies) throw new NotFoundException();
    return { state: issueKakaoState(res, this.config.secureCookies) };
  }
}

interface PageConfig {
  javascriptKey: string | null;
  redirectUri: string;
  forceLogin: boolean;
  mailToLog: boolean;
}

function renderPage(config: PageConfig): string {
  // <script> 안에 넣으므로 '<' 를 이스케이프 (</script> 주입 방지)
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>인증 테스트</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 560px; margin: 40px auto; padding: 0 16px; }
  button { padding: 10px 16px; margin-right: 8px; border-radius: 8px; border: 1px solid #ccc;
    background: #fff; font-size: 15px; cursor: pointer; }
  button.kakao { background: #fee500; border-color: #fee500; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  pre { background: #f5f5f5; padding: 12px; border-radius: 8px; white-space: pre-wrap; word-break: break-all; }
  .warn { color: #b00020; }
  .hint { color: #666; font-size: 14px; }
  fieldset { border: 1px solid #ddd; border-radius: 8px; padding: 12px 16px; margin: 16px 0; }
  input { padding: 9px 10px; border: 1px solid #ccc; border-radius: 8px; font-size: 15px; width: 220px; margin: 4px 8px 4px 0; }
  #email-code { width: 110px; letter-spacing: 4px; }
</style>
<script src="${KAKAO_SDK_URL}" crossorigin="anonymous"></script>
</head>
<body>
<h1>인증 테스트 (개발용)</h1>
<p id="status">확인 중…</p>
<p>
  <button id="kakao-login" class="kakao" disabled>카카오 로그인</button>
  <button id="logout">로그아웃</button>
</p>
<fieldset>
  <legend>이메일 코드 로그인</legend>
  <form id="email-form">
    <input id="email" type="email" placeholder="이메일" autocomplete="email" required>
    <button id="send-code" type="submit">코드 받기</button>
  </form>
  <form id="verify-form" hidden>
    <input id="email-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="6자리" autocomplete="one-time-code" required>
    <button type="submit">로그인</button>
  </form>
  <p id="email-msg" class="hint"></p>
</fieldset>
<p id="warn" class="warn"></p>
<pre id="me"></pre>
<script>
  const CONFIG = ${json};
  const statusEl = document.getElementById('status');
  const meEl = document.getElementById('me');
  const warnEl = document.getElementById('warn');
  const loginBtn = document.getElementById('kakao-login');

  // 카카오 JavaScript SDK 초기화
  if (!window.Kakao) {
    warnEl.textContent = '카카오 SDK를 불러오지 못했습니다. (네트워크 확인)';
  } else if (!CONFIG.javascriptKey) {
    warnEl.textContent = '.env 에 KAKAO_JAVASCRIPT_KEY 를 설정한 뒤 서버를 재시작하세요.';
  } else {
    if (!Kakao.isInitialized()) Kakao.init(CONFIG.javascriptKey);
    loginBtn.disabled = false;
  }

  loginBtn.addEventListener('click', async () => {
    // 누를 때마다 새 state를 받아 쿠키에 저장 → 인가 코드를 받아 서버 콜백으로 이동 → JWT 쿠키 발급
    const res = await fetch('/api/auth/dev/state', { method: 'POST', credentials: 'include' });
    if (!res.ok) {
      warnEl.textContent = '로그인 준비에 실패했습니다. (' + res.status + ')';
      return;
    }
    const { state } = await res.json();
    const options = { redirectUri: CONFIG.redirectUri, state };
    if (CONFIG.forceLogin) options.prompt = 'login'; // 개발용: 카카오 세션이 있어도 로그인 화면 표시
    Kakao.Auth.authorize(options);
  });

  // access 토큰(15분)이 만료되면 refresh로 한 번 재발급 후 재시도
  async function fetchMe() {
    let res = await fetch('/api/me', { credentials: 'include' });
    if (res.status === 401) {
      const refreshed = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
      if (refreshed.ok) res = await fetch('/api/me', { credentials: 'include' });
    }
    return res;
  }

  async function load() {
    const res = await fetchMe();
    if (res.ok) {
      const [me] = await res.json();
      statusEl.textContent = '로그인됨';
      meEl.textContent = JSON.stringify(me, null, 2);
    } else {
      statusEl.textContent = '로그아웃 상태';
      meEl.textContent = '';
    }
  }

  // 이메일 코드 로그인: ① 코드 받기 → ② 코드 입력 → 쿠키 발급
  const emailInput = document.getElementById('email');
  const codeInput = document.getElementById('email-code');
  const verifyForm = document.getElementById('verify-form');
  const emailMsg = document.getElementById('email-msg');
  const sendBtn = document.getElementById('send-code');

  async function errorText(res) {
    try {
      const body = await res.json();
      return Array.isArray(body.message) ? body.message.join(' / ') : body.message || res.status;
    } catch {
      return res.status;
    }
  }

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  document.getElementById('email-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    sendBtn.disabled = true;
    emailMsg.textContent = '보내는 중…';
    const res = await post('/api/auth/email/code', { email: emailInput.value });
    sendBtn.disabled = false;
    if (!res.ok) {
      emailMsg.textContent = '실패: ' + (await errorText(res));
      return;
    }
    verifyForm.hidden = false;
    codeInput.value = '';
    codeInput.focus();
    emailMsg.textContent = CONFIG.mailToLog
      ? 'SMTP 설정이 없어 메일 대신 서버 로그(터미널)에 코드가 찍혔습니다. 10분 안에 입력하세요.'
      : emailInput.value + ' 로 코드를 보냈습니다. 10분 안에 입력하세요.';
    sendBtn.textContent = '코드 다시 받기';
  });

  verifyForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await post('/api/auth/email/verify', { email: emailInput.value, code: codeInput.value.trim() });
    if (!res.ok) {
      emailMsg.textContent = '실패: ' + (await errorText(res));
      return;
    }
    // 카카오 로그인과 똑같이 로그인 후 내 정보 JSON(/api/me)으로 이동
    location.href = '/api/me';
  });

  document.getElementById('logout').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    await load();
  });

  load();
</script>
</body>
</html>`;
}
