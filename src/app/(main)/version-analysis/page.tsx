
'use client';
import {AppTopBar} from '@/components/shell/AppTopBar';
import {PageContainer} from '@/components/shell/PageContainer';
import VersionExperiments from '@/components/evaluation-harness/VersionExperiments';
import {useEvaluationCatalog} from '@/components/evaluation-harness/useEvaluationCatalog';
export default function VersionAnalysisPage(){const {catalog,loaded,error}=useEvaluationCatalog();return <><AppTopBar title="版本分析"/><PageContainer className="px-6 py-5">{error&&<p role="alert" className="text-error">{error}</p>}<VersionExperiments assets={catalog.assets} runs={catalog.runs} loaded={loaded}/></PageContainer></>;}
