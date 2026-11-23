import test from 'node:test';import assert from 'node:assert/strict';
test('collector model transport sends only explicitly configured authentication',async()=>{
 const {configuredModelFetch}=await import('@/lib/server/configured-model-fetch');let captured:Headers|undefined;const transport:typeof fetch=async(_input,init)=>{captured=new Headers(init?.headers);return Response.json({ok:true});};
 await configuredModelFetch({},transport)('http://localhost/model',{headers:{authorization:'Bearer no-api-key-required','api-key':'custom-kept'}});assert.equal(captured!.has('authorization'),false);assert.equal(captured!.get('api-key'),'custom-kept');
 await configuredModelFetch({headers:{Authorization:'Custom explicit'}},transport)('http://localhost/model',{headers:{authorization:'Custom explicit'}});assert.equal(captured!.get('authorization'),'Custom explicit');
 await configuredModelFetch({apiKey:'configured'},transport)('http://localhost/model',{headers:{authorization:'Bearer configured'}});assert.equal(captured!.get('authorization'),'Bearer configured');
});
