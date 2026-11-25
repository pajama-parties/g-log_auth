import { z } from 'zod';
import { nickname } from '../auth/auth.schemas.js';

/** 스웨거 components.schemas.User (응답) */
export const meResponseSchema = z.object({
  name: z.string().meta({ example: '김지은' }),
  role: z.string().meta({ example: '식물 집사' }),
  email: z.string().nullable(),
  connectedAt: z.string().nullable().meta({ description: '카카오 연결일 표시 문자열', example: '10월 30일' }),
  kakaoConsent: z.boolean().meta({ description: '카카오톡 메시지 전송 동의' }),
  potCount: z.number().int(),
  sensorOnline: z.number().int(),
  sensorTotal: z.number().int(),
  recordedDays: z.number().int(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/** 바꾼 항목만. 그 밖의 키(role 등)가 오면 400 */
export const updateMeSchema = z.strictObject({
  name: nickname.optional(),
  kakaoConsent: z.boolean({ error: 'kakaoConsent는 true/false여야 합니다.' }).optional(),
});
export type UpdateMeInput = z.infer<typeof updateMeSchema>;

export const withdrawSchema = z.object({
  confirm: z.literal('삭제', { error: '확인 문구 "삭제"를 입력해 주세요.' }),
});
