
'use client';
import {AppTopBar} from '@/components/shell/AppTopBar';
import {PageContainer} from '@/components/shell/PageContainer';
import VersionExperiments from '@/components/evaluation-harness/VersionExperiments';
import {useEvaluationCatalog} from '@/components/evaluation-harness/useEvaluationCatalog';
import TraceVersionAnalysis from '@/components/observe/TraceVersionAnalysis';
import {VersionWorkspaceTabs} from '@/components/observe/VersionWorkspaceTabs';
import {NH_DEMO} from '@/lib/evaluation-harness/demo-profile';

function EvaluationVersionAnalysis(){const {catalog,loaded,error}=useEvaluationCatalog();return <PageContainer variant="wide" className="bg-background">{error&&<p role="alert" className="text-error">{error}</p>}<VersionExperiments assets={catalog.assets} runs={catalog.runs} loaded={loaded}/></PageContainer>;}

export default function VersionAnalysisPage(){return <><AppTopBar title="版本分析"/>{NH_DEMO?<EvaluationVersionAnalysis/>:<><VersionWorkspaceTabs/><TraceVersionAnalysis/></>}</>;}
