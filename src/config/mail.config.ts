import { LogMailTransport, SmtpTransport, type MailModuleOptions } from '@nestjs/mail';
import type { EnvGetter } from './database.config.js';

/**
 * 메일 발송 설정.
 * - SMTP_USER가 있으면 SMTP(기본 Gmail smtp.gmail.com:465)로 실제 발송
 * - 없으면 개발용: 메일을 보내지 않고 서버 로그에 내용(인증 코드 포함)을 출력 (운영에서는 시작 단계에서 막힘)
 */
export function mailOptions(get: EnvGetter): MailModuleOptions {
  const user = get('SMTP_USER');
  if (!user) {
    return { transport: new LogMailTransport({ body: true }), from: get('MAIL_FROM') || 'g-log <no-reply@localhost>' };
  }
  // Gmail 앱 비밀번호는 "abcd efgh ijkl mnop"처럼 공백이 섞여 보이므로 제거
  const pass = (get('SMTP_PASS') ?? '').replace(/\s+/g, '');
  if (!pass) throw new Error('환경 변수 SMTP_PASS 가 비어 있습니다. Gmail이면 앱 비밀번호를 넣으세요 (.env.example 참고).');
  return {
    transport: new SmtpTransport({
      host: get('SMTP_HOST') || 'smtp.gmail.com',
      port: Number(get('SMTP_PORT') || 465),
      auth: { user, pass },
      pool: true,
    }),
    from: get('MAIL_FROM') || `g-log <${user}>`,
    retry: 2,
  };
}
