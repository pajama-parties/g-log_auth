import { z } from 'zod';

/** 이메일은 앞뒤 공백 제거 + 소문자로 저장·비교 (A@x.com 과 a@x.com 은 같은 계정) */
const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: '이메일 형식이 올바르지 않습니다.' }).max(255, { error: '이메일이 너무 깁니다.' }));

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 64;
export const NICKNAME_MAX = 30;

/** 가입할 때만 규칙 검사 (로그인은 예전 규칙으로 만든 비밀번호도 받아야 하므로 길이 상한만) */
const newPassword = z
  .string()
  .min(PASSWORD_MIN, { error: `비밀번호는 ${PASSWORD_MIN}자 이상이어야 합니다.` })
  .max(PASSWORD_MAX, { error: `비밀번호는 ${PASSWORD_MAX}자 이하여야 합니다.` })
  .regex(/[A-Za-z]/, { error: '비밀번호에 영문자를 넣어 주세요.' })
  .regex(/\d/, { error: '비밀번호에 숫자를 넣어 주세요.' });

export const nickname = z
  .string()
  .trim()
  .min(1, { error: '닉네임을 입력해 주세요.' })
  .max(NICKNAME_MAX, { error: `닉네임은 ${NICKNAME_MAX}자 이하여야 합니다.` });

export const signupSchema = z
  .object({ email, password: newPassword, name: nickname })
  .meta({ description: '이메일 가입. 성공하면 바로 로그인됨 (쿠키 발급)' });
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email,
  password: z.string().min(1, { error: '비밀번호를 입력해 주세요.' }).max(1024),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const kakaoLoginSchema = z.object({
  code: z.string().min(1).max(512).meta({ description: '카카오 인가 코드' }),
});
export type KakaoLoginInput = z.infer<typeof kakaoLoginSchema>;
