CREATE TABLE `diagnosis_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`diagnosis_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `diagnosis_runs_user_idx` ON `diagnosis_runs` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `diagnosis_runs_diag_idx` ON `diagnosis_runs` (`diagnosis_id`);--> statement-breakpoint
ALTER TABLE `diagnoses` ADD `run_id` text;--> statement-breakpoint
-- 기존 진단을 원장에 옮겨 하루 제한 계산이 이어지게 한다.
INSERT INTO `diagnosis_runs` (`user_id`, `diagnosis_id`, `kind`, `created_at`) SELECT `user_id`, `id`, 'create', `created_at` FROM `diagnoses`;
