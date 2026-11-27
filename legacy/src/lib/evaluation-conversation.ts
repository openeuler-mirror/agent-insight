/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { z } from 'zod';

const text = z.string().max(20000);
const tool = z.object({ name: z.string().trim().min(1).max(200), arguments: z.record(z.string(), z.unknown()).optional() });
export const turnExpectationSchema = z.object({
  outputMatch: z.enum(['exact', 'contains']).optional(),
  contains: text.optional(),
  pattern: z.string().max(2000).optional(),
  expectedSkill: z.string().max(200).optional(),
  state: z.string().max(200).optional(),
  requiredTools: z.array(tool).max(30).default([]),
  forbiddenTools: z.array(z.string().min(1).max(200)).max(30).default([]),
  toolOrder: z.array(z.string().min(1).max(200)).max(30).default([]),
  fields: z.array(z.object({
    path: z.string().min(1).max(200),
    type: z.enum(['string', 'number', 'boolean', 'array', 'object']).optional(),
    required: z.boolean().default(true),
    equals: z.unknown().optional(), min: z.number().optional(), max: z.number().optional(),
    enum: z.array(z.unknown()).max(100).optional(),
  })).max(50).default([]),
  blocking: z.boolean().default(true),
}).superRefine((value, ctx) => {
  if (value.outputMatch && (value.contains !== undefined || value.pattern || value.state || value.toolOrder.length || value.fields.length)) ctx.addIssue({code:'custom',message:'简化规则不能与历史高级规则混用，请先明确转换历史规则'});
  if (value.requiredTools.some(t => value.forbiddenTools.includes(t.name))) ctx.addIssue({code:'custom',message:'同一工具不能同时必须调用和禁止调用'});
  if (value.pattern) try { new RegExp(value.pattern); } catch { ctx.addIssue({code:'custom',path:['pattern'],message:'无效正则表达式'}); }
});

export const conversationTurnSchema = z.object({
  id: z.string().min(1).max(100),
  input: text.refine(value => Boolean(value.trim()), '轮次输入不能为空'),
  expectedOutput: text.default(''),
  expectation: turnExpectationSchema.default({}),
});
export type ConversationTurn = z.infer<typeof conversationTurnSchema>;
export type TurnExpectation = ConversationTurn['expectation'];

export function hasLegacyTurnRules(rule: TurnExpectation): boolean {
  return rule.contains !== undefined || Boolean(rule.pattern || rule.state || rule.toolOrder.length || rule.fields.length);
}

export function simplifyConversationTurn(turn: ConversationTurn): ConversationTurn {
  return {...turn, expectedOutput: turn.expectation.contains ?? turn.expectedOutput, expectation: {
    outputMatch: 'contains', expectedSkill: turn.expectation.expectedSkill,
    requiredTools: turn.expectation.requiredTools, forbiddenTools: turn.expectation.forbiddenTools,
    toolOrder: [], fields: [], blocking: true,
  }};
}

const turnsSchema = z.array(conversationTurnSchema).min(1).max(20).refine(turns => new Set(turns.map(turn=>turn.id)).size===turns.length,'轮次标识不能重复');
export const executionConversationSchema = z.object({
  version: z.literal(1),
  turns: z.array(z.object({id:z.string().min(1).max(100),input:text.refine(value=>Boolean(value.trim()))}).strict()).min(1).max(20),
}).strict().refine(value=>new Set(value.turns.map(turn=>turn.id)).size===value.turns.length,'轮次标识不能重复');
export type ExecutionConversation = z.infer<typeof executionConversationSchema>;

export function normalizeConversationTurns(item: {input:string;expectedOutput?:string;turns?:unknown}): ConversationTurn[] {
  const raw = item.turns === undefined ? [{id:'turn-1',input:item.input,expectedOutput:item.expectedOutput || ''}] : item.turns;
  if (!Array.isArray(raw)) throw new z.ZodError([{code:'custom',path:['turns'],message:'逐轮配置必须为数组'}]);
  return turnsSchema.parse(raw.map((turn,index)=>turn && typeof turn==='object' && !Array.isArray(turn) ? {...turn,id:turn.id || `turn-${index+1}`} : turn));
}

export function projectConversationCase<T extends {input:string;expectedOutput:string;turns?:unknown}>(item:T):T {
  if (item.turns === undefined) return item;
  const turns = normalizeConversationTurns(item);
  return {...item,input:turns[0].input,expectedOutput:turns.at(-1)!.expectedOutput,turns};
}

export function toExecutionConversation(turns:ConversationTurn[]):ExecutionConversation | undefined {
  if (turns.length<2) return undefined;
  return executionConversationSchema.parse({version:1,turns:turns.map(({id,input})=>({id,input}))});
}
