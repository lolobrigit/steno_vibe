// Таблицы БД. Аутентификация по Kimi OAuth удалена — таблица users больше
// не нужна. Добавляйте таблицы здесь по мере роста приложения.
// См. docs/Database.md для примеров и паттернов.
//
// Пример:
// import {
//   mysqlTable, serial, varchar, text, timestamp,
// } from "drizzle-orm/mysql-core";
// export const posts = mysqlTable("posts", {
//   id: serial("id").primaryKey(),
//   title: varchar("title", { length: 255 }).notNull(),
//   content: text("content"),
//   createdAt: timestamp("created_at").notNull().defaultNow(),
// });
//
// Примечание: FK-колонки, ссылающиеся на serial()-PK, должны использовать:
//   bigint("columnName", { mode: "number", unsigned: true }).notNull()
