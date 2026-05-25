import { NextResponse } from 'next/server';

 
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
    try {
        const formData = await request.formData();
        const file = formData.get('document') as File | null;
        
        if (!file) {
            return NextResponse.json({ error: '请上传文档' }, { status: 400 });
        }
        
        const fileName = file.name.toLowerCase();
        let documentContent = '';

        if (fileName.endsWith('.pdf')) {
            const arrayBuffer = await file.arrayBuffer();
             const buffer = Buffer.from(arrayBuffer);
             const pdfData = await pdfParse(buffer);
             documentContent = pdfData.text;
        } else {
             documentContent = await file.text();
        }
        
        return NextResponse.json({ content: documentContent });
    } catch (error: any) {
        console.error('Parse Document Error:', error);
        return NextResponse.json({ error: error.message || '文档解析失败' }, { status: 500 });
    }
}
