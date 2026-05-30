import type { AiReview, DailyReport, StrengthProfile, Survey } from "./types.js";

const groqModel = process.env.GROQ_MODEL || "llama-3.1-8b-instant";

function extractJson(text: string) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) return undefined;
  return text.slice(start, end + 1);
}

async function callGroq(prompt: string) {
  if (!process.env.GROQ_API_KEY) return undefined;

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: groqModel,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "Ты HR/ERP аналитик. Отвечай только валидным JSON без markdown. Оценивай продуктивность бережно, прозрачно и доказательно."
        },
        { role: "user", content: prompt }
      ]
    })
  });

  if (!response.ok) return undefined;
  const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content;
}

function normalizeReview(review: Partial<AiReview>, model: string): AiReview {
  return {
    productivityScore: Math.max(0, Math.min(100, Number(review.productivityScore || 0))),
    summary: review.summary || "AI обработал отчет, но не вернул подробную сводку.",
    risks: Array.isArray(review.risks) ? review.risks : [],
    nextActions: Array.isArray(review.nextActions) ? review.nextActions : [],
    deadlineImpactDays: Math.max(0, Number(review.deadlineImpactDays || 0)),
    criteria: {
      resultClarity: Number(review.criteria?.resultClarity || 0),
      planClarity: Number(review.criteria?.planClarity || 0),
      blockerControl: Number(review.criteria?.blockerControl || 0),
      initiative: Number(review.criteria?.initiative || 0)
    },
    explanation: review.explanation || "Оценка рассчитана по содержательности результата, конкретности плана и наличию блокеров.",
    confidence: review.confidence || "medium",
    model
  };
}

export async function reviewReport(report: Pick<DailyReport, "yesterday" | "todayPlan" | "blockers">): Promise<AiReview> {
  const prompt = `
Проанализируй ежедневный отчет стажера.
Верни JSON:
{
  "productivityScore": number от 0 до 100,
  "summary": "краткая сводка",
  "risks": ["риски"],
  "nextActions": ["следующие действия"],
  "deadlineImpactDays": number,
  "criteria": {
    "resultClarity": number от 0 до 100,
    "planClarity": number от 0 до 100,
    "blockerControl": number от 0 до 100,
    "initiative": number от 0 до 100
  },
  "explanation": "почему выставлен такой балл",
  "confidence": "low" | "medium" | "high"
}

Сделано вчера: ${report.yesterday}
План: ${report.todayPlan}
Блокеры: ${report.blockers || "нет"}
`;

  const aiText = await callGroq(prompt);
  if (aiText) {
    const parsed = extractJson(aiText);
    if (parsed) {
      try {
        return normalizeReview(JSON.parse(parsed) as Partial<AiReview>, groqModel);
      } catch {
        // Local fallback below keeps the product usable during API hiccups.
      }
    }
  }

  const wordCount = `${report.yesterday} ${report.todayPlan}`.split(/\s+/).filter(Boolean).length;
  const hasBlocker = report.blockers.trim().length > 0;
  const hasConcretePlan = /(запустить|сделать|подготовить|починить|проверить|согласовать|описать|реализовать|исправить|собрать)/i.test(
    report.todayPlan
  );
  const hasConcreteResult = /(сделал|собрал|подготовил|починил|проверил|описал|реализовал|создал|изучил)/i.test(
    report.yesterday
  );
  const resultClarity = Math.min(100, 35 + wordCount * 2 + (hasConcreteResult ? 20 : 0));
  const planClarity = hasConcretePlan ? 82 : 48;
  const blockerControl = hasBlocker ? 45 : 90;
  const initiative = Math.min(100, 50 + (hasConcretePlan ? 20 : 0) + (hasConcreteResult ? 15 : 0));
  const productivityScore = Math.round(resultClarity * 0.35 + planClarity * 0.25 + blockerControl * 0.2 + initiative * 0.2);

  return {
    productivityScore,
    summary: hasBlocker
      ? "Есть прогресс, но блокер может повлиять на срок."
      : "Отчет содержит результат и следующий рабочий шаг.",
    risks: hasBlocker ? [report.blockers] : ["Критичных рисков не выявлено"],
    nextActions: hasConcretePlan ? ["Продолжить по указанному плану"] : ["Сформулировать план в измеримых задачах"],
    deadlineImpactDays: hasBlocker ? 1 : 0,
    criteria: { resultClarity, planClarity, blockerControl, initiative },
    explanation: "Локальная оценка учитывает конкретность результата, ясность плана, наличие блокеров и инициативность.",
    confidence: "medium",
    model: "local-heuristic"
  };
}

function buildFallbackSurveyProfile(answers: Survey["answers"]): StrengthProfile {
  const strengths = answers.traits.slice(0, 3);
  const skills = answers.skills.toLowerCase();
  const lowExperience = /нет|начина|0|мало/i.test(answers.experience);
  const suggestedTrack = skills.includes("sql") || skills.includes("аналит")
    ? "аналитика и работа с данными"
    : skills.includes("react") || skills.includes("node") || skills.includes("typescript")
      ? "разработка ERP"
      : skills.includes("продаж") || skills.includes("маркет")
        ? "маркетинг и продажи"
        : "индивидуальный трек под цель стажировки";

  return {
    strengths: strengths.length ? strengths : ["ответственность", "готовность учиться"],
    weaknesses: lowExperience ? ["нужна поддержка в базовых рабочих процессах"] : ["стоит точнее декомпозировать задачи"],
    skillsSummary: `Заявленные навыки: ${answers.skills}.`,
    experienceSummary: lowExperience
      ? `Опыт пока начальный: ${answers.experience}. Нужны короткие задачи и частая обратная связь.`
      : `Опыт можно использовать в рабочих задачах: ${answers.experience}.`,
    goalAlignment: `Цель стажировки: ${answers.goal}. Рекомендуется связать недельные задачи с этой целью.`,
    suggestedTrack,
    mentorFocus: lowExperience
      ? ["дать базовый onboarding-план", "проверять понимание задачи до начала работы", "чаще давать обратную связь"]
      : ["дать самостоятельный мини-проект", "сверять прогресс по дэйликам", "развивать слабые зоны через парные задачи"],
    recommendation: "Дать стажеру короткие недельные цели и сверять прогресс по ежедневным отчетам.",
    riskLevel: lowExperience ? "medium" : "low"
  };
}

export async function analyzeSurvey(answers: Survey["answers"]): Promise<StrengthProfile> {
  const prompt = `
Проанализируй первичный опрос стажера. Обязательно учитывай профессиональные навыки, опыт и цель стажировки.
Верни JSON:
{
  "strengths": ["сильные стороны"],
  "weaknesses": ["зоны роста"],
  "skillsSummary": "что видно по профессиональным навыкам",
  "experienceSummary": "как опыт влияет на стартовые задачи и уровень самостоятельности",
  "goalAlignment": "насколько цель стажировки совпадает с навыками и категорией роста",
  "suggestedTrack": "рекомендуемый трек развития",
  "mentorFocus": ["на чем тимлиду сфокусироваться"],
  "recommendation": "короткая рекомендация тимлиду",
  "riskLevel": "low" | "medium" | "high"
}

Черты: ${answers.traits.join(", ")}
Навыки: ${answers.skills}
Опыт: ${answers.experience}
Стиль обучения: ${answers.learningStyle}
Цель: ${answers.goal}
`;

  const aiText = await callGroq(prompt);
  if (aiText) {
    const parsed = extractJson(aiText);
    if (parsed) {
      try {
        const profile = JSON.parse(parsed) as StrengthProfile;
        return {
          ...buildFallbackSurveyProfile(answers),
          ...profile,
          mentorFocus: Array.isArray(profile.mentorFocus) ? profile.mentorFocus : buildFallbackSurveyProfile(answers).mentorFocus
        };
      } catch {
        // Keep onboarding available without a valid AI response.
      }
    }
  }

  return buildFallbackSurveyProfile(answers);
}
