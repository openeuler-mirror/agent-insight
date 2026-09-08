'use client';
import {useCallback,useEffect,useState} from 'react';
import {apiFetch} from '@/lib/client/api';
import {useAuth} from '@/lib/auth/auth-context';
export interface CatalogAsset {id:string;kind:string;assetKey:string;name:string;version:number;archived:boolean;content:any;contentHash:string;createdAt:string}
export interface EvaluationCatalog {statistics?:{todayCount:number;runningCount:number;failedCount:number};assets:CatalogAsset[];runs:any[];credentials:Array<{id:string;name:string}>;executionOptions:{demoEndpoint:string;demoModels:string[];publicModel:string;publicModelConfigured:boolean}}
const empty:EvaluationCatalog={assets:[],runs:[],credentials:[],executionOptions:{demoEndpoint:'',demoModels:[],publicModel:'',publicModelConfigured:false}};
export function useEvaluationCatalog(){
 const {apiKey,user}=useAuth();const [catalog,setCatalog]=useState(empty),[loaded,setLoaded]=useState(false),[error,setError]=useState('');
 const request=useCallback(async(body?:unknown,query='')=>{const response=await apiFetch('/api/evaluation-harness'+query,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','x-witty-api-key':apiKey||''},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();if(!response.ok)throw Error(data.error||'操作失败');return data;},[apiKey]);
 const refresh=useCallback(async()=>{const data=await request();setCatalog({...empty,...data});setLoaded(true);},[request]);
 useEffect(()=>{if(apiKey)void refresh().catch(e=>setError(e.message));},[apiKey,refresh]);
 return {catalog,loaded,error,setError,request,refresh,user};
}
