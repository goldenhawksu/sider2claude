import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ControllerSqliteStore } from '../src/utils/controller-storage';
import { strictControllerCalls, readControllerText, saveControllerText, extractReadJson } from '../src/utils/sider-controller';
import { validDeclaredToolInput } from '../src/utils/tool-input-validation';
import { convertAnthropicToSiderSync } from '../src/utils/request-converter';
import { restoreToolUseFromText } from '../src/utils/textual-tool-use';
import { fetchSiderResponse } from '../src/utils/sider-transport';
import { SiderClient } from '../src/utils/sider-client';
import { controllerResponse } from '../src/utils/controller-http';
import { createRequestLogContext } from '../src/utils/request-observability';

const tools: any[]=[{name:'Read',input_schema:{type:'object',properties:{file_path:{type:'string'}},required:['file_path']}}];
test('Bun续轮保留纯工具结果和错误标记',()=>{
  const request:any={model:'claude-opus-5.5',messages:[{role:'user',content:[{type:'tool_result',tool_use_id:'id',is_error:true,content:'端口8080'}]}]};
  const text=convertAnthropicToSiderSync(request,'real-cid').multi_content[0]!.text;
  expect(text).toContain('端口8080');expect(text).toContain('is_error=true');
});
test('Bun严格工具验证与Deno同样拒绝未知名称及无效类型',()=>{
  expect(()=>strictControllerCalls('[tool_use:Unknown] id=1 input={}',tools)).toThrow();
  expect(()=>strictControllerCalls('[tool_use:Read] id=1 input={"file_path":123}',tools)).toThrow();
  const restored=restoreToolUseFromText('[tool_use:Read] id=1 input={"file_path":123}',{model:'claude-opus-5.5',messages:[],tools});
  expect(restored.toolUseCount).toBe(0);expect(restored.unparsedCount).toBe(1);
});
test('Bun SQLite：跨实例内容读取、分块损坏与任务隔离',async()=>{
  const db=new Database(':memory:');
  try {
    const a=new ControllerSqliteStore(db),b=new ControllerSqliteStore(db);const text='中文😀\\"\n'.repeat(25000);
    await saveControllerText(a,'owner:task:asset',text);expect(await readControllerText(b,'owner:task:asset')).toBe(text);
    await expect(readControllerText(b,'other:task:asset')).rejects.toThrow();
    await b.write('owner:task:asset:0','bad',1000);await expect(readControllerText(a,'owner:task:asset')).rejects.toThrow('哈希');
  }finally{db.close();}
});
test('Bun SQLite：租约互斥及过期读取',async()=>{
  const db=new Database(':memory:');
  try{
    const a=new ControllerSqliteStore(db),b=new ControllerSqliteStore(db);
    expect(await a.claim('account','a',1000)).toBe(true);expect(await b.claim('account','b',1000)).toBe(false);
    await a.release('account','wrong');expect(await b.claim('account','b',1000)).toBe(false);
    await b.release('account','a');expect(await b.claim('account','b',1000)).toBe(true);
    await a.write('expired','x',-1);expect(await b.read('expired')).toBeNull();
  }finally{db.close();}
});
test('Bun原生统一事件和HTTP603错误解析',async()=>{
  const original=globalThis.fetch;
  try{
    globalThis.fetch=(()=>Promise.resolve(new Response([{code:0,msg:'ok',data:{type:'tool_call',model:'claude-opus-5.5',tool_call:{id:'id',name:'search',status:'finish',search:{search_snippets:{title:'来源'}}}}},{code:0,msg:'ok',data:{type:'text',model:'claude-opus-5.5',text:'完成'}}].map(e=>`data: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}}))) as typeof fetch;
    const client=new SiderClient();const req:any={cid:'',model:'claude-opus-5.5',multi_content:[{type:'text',text:'probe'}],tools:{auto:[]}};
    const result=await client.chat(req,'test');expect(result.toolResults?.length).toBe(1);expect(result.toolResults?.[0]?.result.search.search_snippets.title).toBe('来源');
    globalThis.fetch=(()=>Promise.resolve(new Response(JSON.stringify({code:603,msg:'Too many words'}),{status:400}))) as typeof fetch;
    await expect(client.chat(req,'test')).rejects.toMatchObject({siderCode:603,statusCode:413});
  }finally{globalThis.fetch=original;}
});
test('Bun上游静默超时会取消正文reader',async()=>{
  const original=globalThis.fetch;let cancelled=false;
  try{
    globalThis.fetch=(()=>Promise.resolve(new Response(new ReadableStream({cancel(){cancelled=true;}})))) as typeof fetch;
    await expect((await fetchSiderResponse('https://sider.ai/x',{},20,100)).text()).rejects.toThrow();expect(cancelled).toBe(true);
  }finally{globalThis.fetch=original;}
});
test('Bun真实Claude Code2020-12工具schema校验',()=>{
  const tool:any={name:'Write',input_schema:{$schema:'https://json-schema.org/draft/2020-12/schema',type:'object',properties:{file_path:{type:'string'},content:{type:'string'}},required:['file_path','content'],additionalProperties:false}};
  expect(validDeclaredToolInput([tool],'Write',{file_path:'C:/isolated/file.json',content:'中文\\"\n'})).toBe(true);
  expect(validDeclaredToolInput([tool],'Write',{file_path:'C:/isolated/file.json',content:123})).toBe(false);
});
test('Bun真实Read展示正文不重复转义，不猜测坏输入',()=>{
  const content='{\n  "text":"中文\\n\\\\路径"\n}';
  expect(extractReadJson(content.split('\n').map((line,i)=>`${i+1}\t${line}`).join('\n'))).toBe(content);
  expect(extractReadJson('1\t{\n3\t}')).toBeNull();
});
test('Bun真实HTTP：上游静默超过10秒时SSE心跳保持连接',async()=>{
  const original=globalThis.fetch;
  const previous={token:process.env.SIDER_AUTH_TOKEN,storage:process.env.SIDER_CONTROLLER_STORAGE,pace:process.env.SIDER_CONTROLLER_PACE_MS};
  process.env.SIDER_AUTH_TOKEN='controller-http-test';process.env.SIDER_CONTROLLER_STORAGE='memory';process.env.SIDER_CONTROLLER_PACE_MS='0';
  const request={model:'claude-opus-5.5',messages:[{role:'user' as const,content:crypto.randomUUID()}],stream:true};
  const server=Bun.serve({port:0,idleTimeout:10,fetch:()=>controllerResponse(request,'local-test-owner',createRequestLogContext(request))});
  try {
    globalThis.fetch=(async()=>{
      await new Promise(resolve=>setTimeout(resolve,11_500));
      return new Response([{code:0,msg:'ok',data:{type:'message_start',model:request.model,message_start:{cid:'slow-cid',user_message_id:'u',assistant_message_id:'a'}}},{code:0,msg:'ok',data:{type:'text',model:request.model,text:'HTTP保持连接成功'}}].map(e=>`data: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
    }) as typeof fetch;
    const response=await original(`http://localhost:${server.port}`);const text=await response.text();
    expect(text).toContain('event: ping');expect(text).toContain('HTTP保持连接成功');expect(text).toContain('event: message_stop');
  }finally{
    globalThis.fetch=original;server.stop(true);
    for(const [key,value]of [['SIDER_AUTH_TOKEN',previous.token],['SIDER_CONTROLLER_STORAGE',previous.storage],['SIDER_CONTROLLER_PACE_MS',previous.pace]]){if(value===undefined)delete process.env[key!];else process.env[key!]=value;}
  }
},20_000);
