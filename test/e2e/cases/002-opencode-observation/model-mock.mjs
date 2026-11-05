import http from 'node:http';

export function mockReply(input,expected){
  if(!Array.isArray(input.tools)||!input.tools.length)return {role:'assistant',content:'E2E observation'};
  const messages=input.messages||[];
  const toolMessages=messages.filter(m=>m.role==='tool');
  if(toolMessages.length){
    const output=JSON.stringify(toolMessages);
    if(!output.includes(String(expected.lineCount))||!output.includes(expected.firstLine))throw Error('Missing actual tool output');
    return {role:'assistant',content:`总行数：${expected.lineCount}\n第一行：${expected.firstLine}`};
  }
  if(!JSON.stringify(messages.filter(m=>m.role==='user')).includes(expected.file))throw Error('Unexpected fixture path');
  const tool=input.tools.find(t=>['bash','shell'].includes(t.function?.name));
  if(!tool)throw Error('No supported readonly terminal tool');
  const properties=tool.function.parameters?.properties||{command:{type:'string'}};
  const quote=s=>"'"+s.replace(/'/g,"'\\''")+"'";
  const command=`awk 'END{print NR}' ${quote(expected.file)} && head -n 1 ${quote(expected.file)}`;
  const args={command};
  if(properties.description)args.description='Read fixture line count and first line';
  if(properties.timeout)args.timeout=10000;
  return {role:'assistant',tool_calls:[{id:'call_e2e_read',type:'function',function:{name:tool.function.name,arguments:JSON.stringify(args)}}]};
}

export async function startModelMock(expected,options={}){
  const evidence={requests:0,toolCalls:0,answers:0,errors:[]};
  const server=http.createServer(async(req,res)=>{
    try{
      if(req.method!=='POST'||!req.url.endsWith('/chat/completions')){res.writeHead(404);res.end();return;}
      let raw='';for await(const part of req){raw+=part;if(raw.length>2*1024*1024)throw Error('Model fixture request too large');}
      const input=JSON.parse(raw);evidence.requests++;
      const message=options.reply?await options.reply(input):mockReply(input,expected);if(message.tool_calls)evidence.toolCalls++;else if(message.content&&(!expected.firstLine||message.content.includes(expected.firstLine)))evidence.answers++;
      const finish=message.tool_calls?'tool_calls':'stop';
      if(input.stream){
        res.writeHead(200,{'content-type':'text/event-stream'});
        const delta={...message,...(message.tool_calls?{tool_calls:message.tool_calls.map((c,index)=>({index,...c}))}:{})};
        const send=(delta,finish_reason=null)=>res.write('data: '+JSON.stringify({id:'e2e-local-model',object:'chat.completion.chunk',model:input.model,choices:[{index:0,delta,finish_reason}]})+'\n\n');
        const plan=options.streamPlan?.(message);
        if(plan&&message.content){
          send({role:'assistant'});
          for(let offset=0;offset<message.content.length;offset+=plan.chunkChars){
            if(res.destroyed)return;send({content:message.content.slice(offset,offset+plan.chunkChars)});
            await new Promise(resolve=>setTimeout(resolve,plan.delayMs));
          }
        }else send(delta);
        if(res.destroyed)return;send({},finish);
        res.end('data: [DONE]\n\n');
      }else{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'e2e-local-model',object:'chat.completion',model:input.model,choices:[{index:0,message,finish_reason:finish}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));}
    }catch(error){evidence.errors.push(error.message);if(res.destroyed)return;if(!res.headersSent)res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:error.message}}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',evidence,close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
}
