export interface EvaluationItem {
    id: string;
    type: 'root_cause' | 'key_action';
    content: string;
    match_score: number;
    explanation: string;
    weight: number;
}

export function parseEvaluationItemsFromReason(judgmentReason: string): EvaluationItem[] {
    const items: EvaluationItem[] = [];
    if (!judgmentReason) return items;

    const lines = judgmentReason.split('\n');
    const itemIndex = { rc: 0, ka: 0 };

    for (const line of lines) {
        const rcMatch = line.match(/\*\*Root Cause\*\*\s*\[(.*?)\]\s*.*?:\s*(\d+)%\s*match\.\s*(.+?)\s*\(Weight:\s*([\d.]+)\)/);
        if (rcMatch) {
            items.push({
                id: `RC-${itemIndex.rc++}`,
                type: 'root_cause',
                content: rcMatch[1].replace(/\.{3}$/, ''),
                match_score: parseInt(rcMatch[2]) / 100,
                explanation: rcMatch[3].trim(),
                weight: parseFloat(rcMatch[4]),
            });
            continue;
        }

        const kaMatchWithWeight = line.match(/\*\*Key Action\*\*\s*\[(.*?)\]\s*.*?:\s*(\d+)%\s*match\.\s*(.+?)\s*\(Weight:\s*([\d.]+)\)/);
        if (kaMatchWithWeight) {
            items.push({
                id: `KA-${itemIndex.ka++}`,
                type: 'key_action',
                content: kaMatchWithWeight[1].replace(/\.{3}$/, ''),
                match_score: parseInt(kaMatchWithWeight[2]) / 100,
                explanation: kaMatchWithWeight[3].trim(),
                weight: parseFloat(kaMatchWithWeight[4]),
            });
            continue;
        }

        const kaMatchSkipped = line.match(/\*\*Key Action\*\*\s*\[(.*?)\]\s*.*?:\s*(\d+)%\s*match\.\s*(.+?)\s*\(该分支未触发，不计入总分\)/);
        if (kaMatchSkipped) {
            items.push({
                id: `KA-${itemIndex.ka++}`,
                type: 'key_action',
                content: kaMatchSkipped[1].replace(/\.{3}$/, ''),
                match_score: parseInt(kaMatchSkipped[2]) / 100,
                explanation: kaMatchSkipped[3].trim(),
                weight: 0,
            });
        }
    }

    return items;
}
