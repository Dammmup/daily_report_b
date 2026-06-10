import { Markup } from "telegraf";
import { appUrl } from "./config.js";

// Билдеры инлайн-клавиатур Telegram-бота. Чистые функции без состояния.

export function groupDepartmentKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("ERP", "group:department:erp"), Markup.button.callback("Data", "group:department:data")],
    [Markup.button.callback("System Analytics", "group:department:system"), Markup.button.callback("ML", "group:department:ml")],
    [Markup.button.callback("Marketing", "group:department:marketing"), Markup.button.callback("Sales", "group:department:sales")],
    [Markup.button.callback("Security", "group:department:security")]
  ]);
}

export function groupActionsKeyboard(enabled?: boolean, funEnabled?: boolean) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Статус группы", "group:status"), Markup.button.callback("Сменить департамент", "group:department:choose")],
    [Markup.button.callback("План группы", "plan:view"), Markup.button.callback("Дайджест дня", "group:digest:now")],
    [Markup.button.callback("Отправить мотивацию", "group:motivation:now")],
    [
      enabled
        ? Markup.button.callback("Отключить мотивацию", "group:motivation:off")
        : Markup.button.callback("Включить мотивацию", "group:motivation:on")
    ],
    [
      funEnabled
        ? Markup.button.callback("Отключить GIF/стикеры", "group:fun:off")
        : Markup.button.callback("Включить GIF/стикеры", "group:fun:on")
    ]
  ]);
}

export function groupMenuKeyboard(enabled?: boolean, funEnabled?: boolean) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("План группы", "plan:view"), Markup.button.callback("Сводка группы", "summary:view")],
    [Markup.button.callback("Статус группы", "group:status"), Markup.button.callback("Сменить департамент", "group:department:choose")],
    [Markup.button.callback("Дайджест дня", "group:digest:now"), Markup.button.callback("Отправить мотивацию", "group:motivation:now")],
    [
      enabled
        ? Markup.button.callback("Отключить мотивацию", "group:motivation:off")
        : Markup.button.callback("Включить мотивацию", "group:motivation:on")
    ],
    [
      funEnabled
        ? Markup.button.callback("Отключить GIF/стикеры", "group:fun:off")
        : Markup.button.callback("Включить GIF/стикеры", "group:fun:on")
    ]
  ]);
}

export function mainMenuKeyboard(role?: string) {
  const rows = [
    [Markup.button.callback("План", "plan:view"), Markup.button.callback("Мои задачи", "tasks:mine")],
    [Markup.button.callback("Дэйлик", "daily:start"), Markup.button.callback("Блокер", "blocker:start")],
    [Markup.button.webApp("Открыть приложение", appUrl)]
  ];

  if (role === "lead") {
    rows.splice(2, 0, [Markup.button.callback("Сводка", "summary:view"), Markup.button.callback("Автосводка", "digest:view")]);
  }

  rows.push([Markup.button.callback("Привязка", "link:help")]);
  return Markup.inlineKeyboard(rows);
}

export function planKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Мои задачи", "tasks:mine"), Markup.button.callback("Свободные шаги", "tasks:available")],
    [Markup.button.callback("Все шаги", "plan:steps")],
    [Markup.button.callback("Написать дэйлик", "daily:start"), Markup.button.callback("Сообщить блокер", "blocker:start")],
    [Markup.button.webApp("Открыть приложение", appUrl)]
  ]);
}

export function taskKeyboard(stepId: string, status: string) {
  const statusRow =
    status === "done" || status === "canceled"
      ? [Markup.button.callback("Вернуть в работу", `task:status:${stepId}:in_progress`)]
      : [
          Markup.button.callback("В работу", `task:status:${stepId}:in_progress`),
          Markup.button.callback("Готово", `task:status:${stepId}:done`),
          Markup.button.callback("Отменить", `task:status:${stepId}:canceled`)
        ];
  return Markup.inlineKeyboard([statusRow, [Markup.button.callback("Есть блокер", `task:blocker:${stepId}`)]]);
}

export function categoryHelp() {
  return [
    "Департаменты:",
    "/group_department system",
    "/group_department ml",
    "/group_department marketing",
    "/group_department sales",
    "/group_department erp",
    "/group_department security"
  ].join("\n");
}
