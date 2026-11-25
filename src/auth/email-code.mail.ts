import { html, type MailSendOptions } from '@nestjs/mail';

/** 이메일 로그인 인증 코드 메일 */
export function emailCodeMail(to: string, code: string, ttlMinutes: number): MailSendOptions {
  return {
    to,
    subject: `[g-log] 로그인 인증 코드 ${code}`,
    html: html`<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px">
  <h2 style="margin:0 0 16px">g-log 로그인 인증 코드</h2>
  <p>아래 코드를 로그인 화면에 입력해 주세요.</p>
  <p style="font-size:32px;font-weight:700;letter-spacing:8px;margin:24px 0">${code}</p>
  <p style="color:#666">코드는 ${ttlMinutes}분 동안 한 번만 쓸 수 있습니다.<br>
  직접 요청하지 않았다면 이 메일을 무시하세요.</p>
</div>`,
  };
}
