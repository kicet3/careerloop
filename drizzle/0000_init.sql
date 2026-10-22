CREATE TABLE `diagnoses` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`target_role` text NOT NULL,
	`situation` text NOT NULL,
	`notes` text,
	`jd_text` text,
	`resume_text` text NOT NULL,
	`resume_file_name` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`share_token` text,
	`model` text NOT NULL,
	`usage` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `diagnoses_share_token_unique` ON `diagnoses` (`share_token`);--> statement-breakpoint
CREATE INDEX `diagnoses_user_idx` ON `diagnoses` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `diagnosis_stages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`diagnosis_id` text NOT NULL,
	`stage` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`output` text,
	`error` text,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`diagnosis_id`) REFERENCES `diagnoses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `diagnosis_stage_uq` ON `diagnosis_stages` (`diagnosis_id`,`stage`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`password_hash` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);