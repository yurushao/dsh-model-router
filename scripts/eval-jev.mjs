import { readFileSync } from 'node:fs';
import {Config} from '../dist/config.js';
import {decide} from '../dist/jev.js';
import {stickyTier} from '../dist/routing.js';
if (!process.env.OPENROUTER_API_KEY) throw new Error('Set OPENROUTER_API_KEY for the paid live regression checks');
const config=Config({apiKey:process.env.OPENROUTER_API_KEY,timeoutMs:10000,models:{economy:{provider:'evaluation',model:'economy'},frontier:{provider:'evaluation',model:'frontier'}}});
const cases=[
['complex-short','开始一个独立的复杂架构任务：设计跨分片事务协调器在网络分区、协调器崩溃与恢复重放下的安全协议，分析原子提交不变量、日志顺序和最难处理的竞态。这里只测试推理能力，不要使用任何工具或修改文件；请用不超过100字给出核心分析。','翻译你好','economy'],
['new-translation','之前的协议审查已结束。开始完全独立的新任务：将“苹果”翻译成英文，只输出一个英文单词，不调用工具。','审查跨分片事务协议的原子性','frontier'],
['followup','继续刚才的协议审查：用一句话概括核心漏洞，不调用工具。','审查跨分片事务协议的原子性','frontier'],
['new-en','The protocol review is finished. New unrelated task: translate 早上好 into English.','Audit a distributed transaction protocol','frontier'],
['short-en','Design a crash-safe distributed transaction protocol and explain its invariants and recovery races in under 100 words.','Translate hello','economy'],
['easy','将“谢谢”翻译成英文。',null,null],
];
const expected=['frontier','economy','frontier','economy','frontier','economy'];
let failed=0;
for(const [id,text,task,tier] of cases){const state={currentMessages:[{role:'user',text}],recentHistory:task?[{role:'user',text:task}]:[],historyTruncated:!!task,toolsAvailable:true,currentTask:task,currentModel:tier?{tier,provider:'openrouter',model:config.models[tier].model}:null};const d=await decide(config,state,new AbortController().signal);const selected=stickyTier(config,d,tier??undefined);const pass=selected===expected.shift();if(!pass)failed++;console.log(JSON.stringify({id,...d,selected,pass}));}

const desktopState=JSON.parse(readFileSync(new URL('./desktop-routing-state.json',import.meta.url),'utf8'));
// Apply the production history window to the captured synthetic conversation.
desktopState.recentHistory=config.historyMessages===0?[]:desktopState.recentHistory.slice(-config.historyMessages);
desktopState.historyTruncated=true;
const replay=await decide(config,desktopState,new AbortController().signal);
const selected=stickyTier(config,replay,'frontier');
const pass=selected==='economy';
if(!pass)failed++;
console.log(JSON.stringify({id:'desktop-history-new-translation',...replay,selected,pass}));
if(failed)process.exitCode=1;
