export interface DiagnosisTextEvent { delta:string; fullText:string }

export class DiagnosisTextQueue {
  private tail:Promise<void>=Promise.resolve();
  private failure:Error|undefined;
  private pending=0;
  private bytes=0;
  constructor(
    private readonly checkpoint:(content:string)=>Promise<void>,
    private readonly deliver:(event:DiagnosisTextEvent)=>void,
    private readonly abort:(error:Error)=>void,
    private readonly limits:{maxPending?:number;maxBytes?:number;maxContentBytes?:number}={},
  ) {}
  private fail(error:unknown) {
    if(this.failure)return;
    this.failure=error instanceof Error?error:new Error('Diagnosis checkpoint failed');
    this.abort(this.failure);
  }
  push(event:DiagnosisTextEvent) {
    if(this.failure)return;
    const size=Buffer.byteLength(event.fullText,'utf8')+Buffer.byteLength(event.delta,'utf8');
    if(this.pending>=(this.limits.maxPending??64)||this.bytes+size>(this.limits.maxBytes??16*1024*1024)
      ||Buffer.byteLength(event.fullText,'utf8')>(this.limits.maxContentBytes??8*1024*1024)) {
      this.fail(Object.assign(new Error('Diagnosis stream budget exceeded'),{status:413}));return;
    }
    this.pending++;this.bytes+=size;
    this.tail=this.tail.then(async()=>{
      if(this.failure)return;
      await this.checkpoint(event.fullText);
      if(!this.failure)this.deliver(event);
    }).catch(error=>this.fail(error)).finally(()=>{this.pending--;this.bytes-=size;});
  }
  effect(action:()=>Promise<void>,size:number) {
    if(this.failure)return;
    if(this.pending>=(this.limits.maxPending??64)||this.bytes+size>(this.limits.maxBytes??16*1024*1024)) {
      this.fail(Object.assign(new Error('Diagnosis stream budget exceeded'),{status:413}));return;
    }
    this.pending++;this.bytes+=size;
    this.tail=this.tail.then(async()=>{if(!this.failure)await action();}).catch(error=>this.fail(error)).finally(()=>{this.pending--;this.bytes-=size;});
  }
  async flush() {await this.tail;if(this.failure)throw this.failure;}
}

interface DiagnosisHandlers {
  onText:(event:DiagnosisTextEvent)=>void;
  onReasoning:(event:{delta:string})=>void;
  onTool:(event:{phase?:string;name?:string;callID?:string;status?:string})=>void;
}
interface DiagnosisResult {sessionId:string;workspaceDir:string;output:string;stats:unknown}
interface DiagnosisTerminal {state:'done'|'failed'|'interrupted';content:string;opencodeSessionId?:string;errorCode?:string}
interface DiagnosisTurn {
  executionId:string;diagnosisSessionId:string;sessionId:string|null;signal?:AbortSignal;leaseIntervalMs?:number;
  execute:(handlers:DiagnosisHandlers,signal:AbortSignal)=>Promise<DiagnosisResult>;
  checkpoint:(content:string)=>Promise<void>;
  renew:()=>Promise<void>;
  finish:(args:DiagnosisTerminal)=>Promise<void>;
}
export function streamDiagnosisTurn(input:DiagnosisTurn):Response {
  const abort=new AbortController();let closed=false;let ended=false;
  const cancelled=()=>abort.abort(new Error('Diagnosis interrupted'));
  const stream=new ReadableStream<Uint8Array>({
    start(controller) {
      const send=(event:string,value:unknown)=>{
        if(closed)return;
        try{controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`));}
        catch{closed=true;cancelled();}
      };
      const close=()=>{closed=true;try{controller.close();}catch{}};
      if(input.signal?.aborted)cancelled();else input.signal?.addEventListener('abort',cancelled,{once:true});
      let durableContent='';let heartbeat:Promise<void>=Promise.resolve();let renewing=false;
      const queue=new DiagnosisTextQueue(async content=>{
        if(abort.signal.aborted)throw abort.signal.reason;
        await input.checkpoint(content);durableContent=content;
      },event=>{if(!abort.signal.aborted)send('text',event);},error=>abort.abort(error));
      // Transient events use the same bounded queue and authorization checkpoint.
      const metadata=(event:string,value:unknown)=>queue.effect(async()=>{
        if(abort.signal.aborted)throw abort.signal.reason;
        await input.renew();if(!abort.signal.aborted)send(event,value);
      },Buffer.byteLength(JSON.stringify(value),'utf8'));
      const timer=setInterval(()=>{
        if(renewing||ended||abort.signal.aborted)return;
        renewing=true;
        heartbeat=input.renew().catch(error=>{if(!ended)abort.abort(error);}).finally(()=>{renewing=false;});
      },input.leaseIntervalMs??15_000);
      send('ready',{executionId:input.executionId,sessionId:input.sessionId,diagnosisSessionId:input.diagnosisSessionId});
      void (async()=>{
        try {
          if(abort.signal.aborted)throw abort.signal.reason;
          const result=await input.execute({onText:event=>queue.push(event),onReasoning:event=>metadata('reasoning',{delta:event.delta}),
            onTool:event=>metadata('tool',{phase:event.phase,name:event.name,callID:event.callID,status:event.status})},abort.signal);
          await queue.flush();await heartbeat;
          if(abort.signal.aborted)throw abort.signal.reason;
          await input.finish({state:'done',content:result.output||durableContent,opencodeSessionId:result.sessionId});
          ended=true;send('done',{sessionId:result.sessionId,diagnosisSessionId:input.diagnosisSessionId,workspaceDir:result.workspaceDir,output:result.output,stats:result.stats});
        } catch {
          await queue.flush().catch(()=>{});await heartbeat;
          const interrupted=abort.signal.aborted;
          const notice=interrupted?'错误: 诊断已中断，请发起新一轮。':'错误: 诊断未完成，请重试。';
          const withNotice=durableContent?durableContent+'\n\n'+notice:notice;
          const content=Buffer.byteLength(withNotice,'utf8')<=8*1024*1024?withNotice:durableContent;
          await input.finish({state:interrupted?'interrupted':'failed',content,errorCode:interrupted?'interrupted':'diagnosis_failed'}).catch(()=>{});
          ended=true;send('error',{message:interrupted?'诊断已中断，请重新载入会话查看已保存内容。':'诊断未完成，请重新载入会话后重试。'});
        } finally {
          ended=true;clearInterval(timer);input.signal?.removeEventListener('abort',cancelled);close();
        }
      })();
    },
    cancel(){closed=true;cancelled();},
  });
  return new Response(stream,{headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform',Connection:'keep-alive','X-Accel-Buffering':'no'}});
}
