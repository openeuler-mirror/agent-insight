'use client';

import { SkillMetadata } from '@/lib/engine/skill-generation/skill-types';
import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/lib/client/api'
import { useTheme, useThemeColors } from '@/lib/client/theme-context';
import {
    Bar,
    BarChart,
    CartesianGrid,
    Legend,
    Line,
    LineChart,
    PolarAngleAxis,
    PolarGrid,
    PolarRadiusAxis,
    Radar,
    RadarChart,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis
} from 'recharts';

// 技能评估可视化组件
export function SkillEvaluation({ skillId }: { skillId?: string }) {
  const { isDark } = useTheme();
  const c = useThemeColors();
  const [skills, setSkills] = useState<SkillMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSkillId, setSelectedSkillId] = useState<string>(skillId || '');
  const [timeRange, setTimeRange] = useState<'7d' | '30d' | '90d' | 'all'>('30d');

  // 获取技能数据
  const fetchSkills = async () => {
    try {
      setLoading(true);
      const response = await apiFetch('/api/skills');
      if (response.ok) {
        const data = await response.json();
        setSkills(data);
        if (!selectedSkillId && data.length > 0) {
          setSelectedSkillId(data[0].id);
        }
      }
    } catch (error) {
      console.error('Error fetching skills:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSkills();
  }, []);

  // 获取选中的技能
  const selectedSkill = useMemo(() => {
    return skills.find(skill => skill.id === selectedSkillId);
  }, [skills, selectedSkillId]);

  // 准备雷达图数据
  const radarData = useMemo(() => {
    if (!selectedSkill) return [];

    const data = [
      { dimension: '质量评分', value: selectedSkill.qualityScore || 0, max: 100 },
      { dimension: '成功率', value: selectedSkill.successRate || 0, max: 100 },
      { dimension: '使用次数', value: Math.min((selectedSkill.usageCount || 0) / 10, 100), max: 100 },
    ];

    // 如果有执行时间数据
    if (selectedSkill.avgExecutionTime) {
      // 执行时间越短越好，所以需要反转评分
      const executionTimeScore = Math.max(0, 100 - (selectedSkill.avgExecutionTime * 10));
      data.push({ dimension: '执行效率', value: executionTimeScore, max: 100 });
    }

    // 如果有Token消耗数据
    if (selectedSkill.avgTokenUsage) {
      // Token消耗越少越好，所以需要反转评分
      const tokenEfficiencyScore = Math.max(0, 100 - (selectedSkill.avgTokenUsage / 100));
      data.push({ dimension: '资源效率', value: tokenEfficiencyScore, max: 100 });
    }

    return data;
  }, [selectedSkill]);

  // 准备使用趋势数据（模拟数据，实际需要从API获取）
  const usageTrendData = useMemo(() => {
    const trendData = [];
    const now = new Date();

    // 生成过去30天的模拟数据
    for (let i = 29; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);

      // 模拟使用数据
      const baseUsage = selectedSkill?.usageCount ? Math.floor(selectedSkill.usageCount / 30) : 1;
      const dailyUsage = Math.max(1, baseUsage + Math.floor(Math.random() * 5) - 2);

      trendData.push({
        date: date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }),
        usage: dailyUsage,
        successRate: (selectedSkill?.successRate || 80) + Math.floor(Math.random() * 20) - 10,
      });
    }

    return trendData;
  }, [selectedSkill]);

  // 准备技能对比数据（所有技能的质量评分）
  const comparisonData = useMemo(() => {
    return skills
      .filter(skill => skill.qualityScore !== undefined)
      .sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0))
      .slice(0, 10)
      .map(skill => ({
        name: skill.name.length > 15 ? skill.name.substring(0, 15) + '...' : skill.name,
        score: skill.qualityScore || 0,
        usage: skill.usageCount || 0,
        category: skill.category,
      }));
  }, [skills]);

  // 准备维度评分数据
  const dimensionData = useMemo(() => {
    if (!selectedSkill) return [];

    // 模拟四个维度的评分数据
    return [
      { dimension: '功能性', score: selectedSkill.qualityScore ? selectedSkill.qualityScore * 0.9 : 70 },
      { dimension: '效率性', score: selectedSkill.successRate ? selectedSkill.successRate * 0.95 : 75 },
      { dimension: '实用性', score: selectedSkill.qualityScore ? selectedSkill.qualityScore * 0.85 : 65 },
      { dimension: '经济性', score: selectedSkill.avgTokenUsage ? 100 - (selectedSkill.avgTokenUsage / 200) : 80 },
    ];
  }, [selectedSkill]);

  if (loading) {
    return (
      <div className="card text-center py-8">
        <div className="text-slate-400">加载技能评估数据中...</div>
      </div>
    );
  }

  if (skills.length === 0) {
    return (
      <div className="card text-center py-8">
        <div className="text-slate-400">还没有注册任何技能</div>
        <p className="text-slate-500 text-sm mt-2">请先注册技能以查看评估数据</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* 技能选择和时间范围筛选 */}
      <div className="card">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">选择技能</label>
            <select
              value={selectedSkillId}
              onChange={(e) => setSelectedSkillId(e.target.value)}
              className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded focus:border-blue-500 focus:outline-none"
            >
              {skills.map(skill => (
                <option key={skill.id} value={skill.id}>
                  {skill.name} {skill.qualityScore !== undefined ? `(${skill.qualityScore}分)` : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">时间范围</label>
            <select
              value={timeRange}
              onChange={(e) => setTimeRange(e.target.value as any)}
              className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded focus:border-blue-500 focus:outline-none"
            >
              <option value="7d">最近7天</option>
              <option value="30d">最近30天</option>
              <option value="90d">最近90天</option>
              <option value="all">全部时间</option>
            </select>
          </div>
        </div>
      </div>

      {selectedSkill && (
        <>
          {/* 技能概览卡片 */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="card">
              <div className="text-sm text-slate-400">质量评分</div>
              <div className={`text-3xl font-bold mt-2 ${
                (selectedSkill.qualityScore || 0) >= 80 ? 'text-green-400' :
                (selectedSkill.qualityScore || 0) >= 60 ? 'text-yellow-400' :
                'text-red-400'
              }`}>
                {selectedSkill.qualityScore !== undefined ? selectedSkill.qualityScore : '-'}
                <span className="text-lg text-slate-400">/100</span>
              </div>
              <div className="text-xs text-slate-500 mt-1">
                {selectedSkill.qualityScore !== undefined ? (
                  selectedSkill.qualityScore >= 80 ? '优秀' :
                  selectedSkill.qualityScore >= 60 ? '良好' : '需要改进'
                ) : '暂无评分'}
              </div>
            </div>

            <div className="card">
              <div className="text-sm text-slate-400">使用次数</div>
              <div className="text-3xl font-bold mt-2">{selectedSkill.usageCount || 0}</div>
              <div className="text-xs text-slate-500 mt-1">总调用次数</div>
            </div>

            <div className="card">
              <div className="text-sm text-slate-400">成功率</div>
              <div className={`text-3xl font-bold mt-2 ${
                (selectedSkill.successRate || 0) >= 90 ? 'text-green-400' :
                (selectedSkill.successRate || 0) >= 75 ? 'text-yellow-400' :
                'text-red-400'
              }`}>
                {selectedSkill.successRate ? `${selectedSkill.successRate.toFixed(1)}%` : '-'}
              </div>
              <div className="text-xs text-slate-500 mt-1">成功执行比例</div>
            </div>

            <div className="card">
              <div className="text-sm text-slate-400">平均执行时间</div>
              <div className="text-3xl font-bold mt-2">
                {selectedSkill.avgExecutionTime ? `${selectedSkill.avgExecutionTime.toFixed(2)}s` : '-'}
              </div>
              <div className="text-xs text-slate-500 mt-1">单次调用平均耗时</div>
            </div>
          </div>

          {/* 雷达图 - 技能维度评估 */}
          <div className="card">
            <h3 className="text-lg font-semibold mb-4">技能维度评估</h3>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <RadarChart data={radarData}>
                  <PolarGrid />
                  <PolarAngleAxis dataKey="dimension" />
                  <PolarRadiusAxis angle={30} domain={[0, 100]} />
                  <Radar
                    name="当前技能"
                    dataKey="value"
                    stroke={c.primary}
                    fill={c.primary}
                    fillOpacity={0.3}
                  />
                </RadarChart>
              </ResponsiveContainer>
            </div>
            <div className="text-sm text-slate-400 mt-2 text-center">
              雷达图显示技能在各维度的表现，越接近外圈表示表现越好
            </div>
          </div>

          {/* 使用趋势图 */}
          <div className="card">
            <h3 className="text-lg font-semibold mb-4">使用趋势</h3>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={usageTrendData}>
                  <CartesianGrid strokeDasharray="3 3" stroke={c.border} />
                  <XAxis dataKey="date" stroke={c.fgMuted} />
                  <YAxis stroke={c.fgMuted} />
                  <Tooltip
                    contentStyle={{ backgroundColor: c.bgSecondary, borderColor: c.borderDark }}
                    labelStyle={{ color: c.fgSecondary }}
                  />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="usage"
                    name="使用次数"
                    stroke={c.primary}
                    strokeWidth={2}
                    dot={{ r: 2 }}
                    activeDot={{ r: 6 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="successRate"
                    name="成功率 (%)"
                    stroke={c.success}
                    strokeWidth={2}
                    dot={{ r: 2 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* 技能对比图 */}
          <div className="card">
            <h3 className="text-lg font-semibold mb-4">技能质量对比</h3>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={comparisonData}>
                  <CartesianGrid strokeDasharray="3 3" stroke={c.border} />
                  <XAxis dataKey="name" stroke={c.fgMuted} angle={-45} textAnchor="end" height={60} />
                  <YAxis stroke={c.fgMuted} domain={[0, 100]} />
                  <Tooltip
                    contentStyle={{ backgroundColor: c.bgSecondary, borderColor: c.borderDark }}
                    formatter={(value) => [`${value}分`, '质量评分']}
                  />
                  <Bar
                    dataKey="score"
                    name="质量评分"
                    fill={c.primary}
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="text-sm text-slate-400 mt-2 text-center">
              显示质量评分最高的10个技能，当前技能已用蓝色高亮
            </div>
          </div>

          {/* 维度详细评分 */}
          <div className="card">
            <h3 className="text-lg font-semibold mb-4">维度详细评分</h3>
            <div className="space-y-4">
              {dimensionData.map((item, index) => (
                <div key={index} className="space-y-2">
                  <div className="flex justify-between">
                    <span className="text-slate-300">{item.dimension}</span>
                    <span className={`font-semibold ${
                      item.score >= 80 ? 'text-green-400' :
                      item.score >= 60 ? 'text-yellow-400' :
                      'text-red-400'
                    }`}>
                      {item.score.toFixed(1)}分
                    </span>
                  </div>
                  <div className="w-full bg-slate-800 rounded-full h-2">
                    <div
                      className={`h-2 rounded-full ${
                        item.score >= 80 ? 'bg-green-500' :
                        item.score >= 60 ? 'bg-yellow-500' :
                        'bg-red-500'
                      }`}
                      style={{ width: `${item.score}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 text-sm text-slate-400">
              <p>• <span className="text-green-400">功能性</span>: 技能输出是否符合预期结果</p>
              <p>• <span className="text-yellow-400">效率性</span>: 执行速度和资源消耗效率</p>
              <p>• <span className="text-blue-400">实用性</span>: 配置便利性和维护性</p>
              <p>• <span className="text-purple-400">经济性</span>: 成本效益和投资回报</p>
            </div>
          </div>

          {/* 技能基本信息 */}
          <div className="card">
            <h3 className="text-lg font-semibold mb-4">技能基本信息</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <div className="text-sm text-slate-400">技能名称</div>
                <div className="text-slate-300">{selectedSkill.name}</div>
              </div>
              <div>
                <div className="text-sm text-slate-400">分类</div>
                <div className="text-slate-300">{selectedSkill.category}</div>
              </div>
              <div>
                <div className="text-sm text-slate-400">版本</div>
                <div className="text-slate-300">{selectedSkill.version}</div>
              </div>
              <div>
                <div className="text-sm text-slate-400">作者</div>
                <div className="text-slate-300">{selectedSkill.author}</div>
              </div>
              <div>
                <div className="text-sm text-slate-400">最后更新</div>
                <div className="text-slate-300">
                  {new Date(selectedSkill.updatedAt).toLocaleDateString('zh-CN')}
                </div>
              </div>
              <div>
                <div className="text-sm text-slate-400">可见性</div>
                <div className="text-slate-300">
                  {selectedSkill.visibility === 'public' ? '公开' :
                   selectedSkill.visibility === 'team' ? '团队' : '私有'}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}