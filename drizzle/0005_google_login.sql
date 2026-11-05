-- users.password_hash를 nullable로 바꾸고 google_sub(unique)를 더한다. SQLite는 컬럼 제약을 바꿀 수 없어 테이블을 다시 만든다.
-- libsql 마이그레이터(client.migrate)가 트랜잭션 밖에서 foreign_keys=off로 실행하므로 DROP TABLE이 자식 행을 cascade 삭제하지 않는다
-- (아래 PRAGMA는 트랜잭션 안이라 효과가 없지만 drizzle-kit 생성 형식을 그대로 둔다). google_sub는 기존 테이블에 없어 NULL로 채운다.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`password_hash` text,
	`google_sub` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "email", "name", "password_hash", "google_sub", "created_at") SELECT "id", "email", "name", "password_hash", NULL, "created_at" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_google_sub_unique` ON `users` (`google_sub`);