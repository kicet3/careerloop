CREATE TABLE `application_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`application_id` text NOT NULL,
	`from_stage` text,
	`to_stage` text NOT NULL,
	`note` text,
	`at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `application_events_app_idx` ON `application_events` (`application_id`,`at`);--> statement-breakpoint
CREATE TABLE `applications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`posting_id` text,
	`company` text NOT NULL,
	`role_title` text NOT NULL,
	`stage` text DEFAULT 'applied' NOT NULL,
	`applied_at` text,
	`next_step` text,
	`next_date` text,
	`note` text,
	`favorite` integer DEFAULT false NOT NULL,
	`resume_id` text,
	`resume_version_id` text,
	`resume_label` text,
	`submitted_key` text,
	`diagnosis_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`posting_id`) REFERENCES `job_postings`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`resume_id`) REFERENCES `company_resumes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`diagnosis_id`) REFERENCES `diagnoses`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `applications_user_idx` ON `applications` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `applications_posting_idx` ON `applications` (`posting_id`);--> statement-breakpoint
CREATE TABLE `job_postings` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`company` text NOT NULL,
	`role_title` text NOT NULL,
	`url` text,
	`url_key` text,
	`platform` text,
	`status` text DEFAULT 'saved' NOT NULL,
	`jd_text` text,
	`deadline` text,
	`deadline_time` text,
	`deadline_kind` text DEFAULT 'unspecified' NOT NULL,
	`employment_type` text DEFAULT 'unknown' NOT NULL,
	`work_type` text DEFAULT 'unknown' NOT NULL,
	`location` text,
	`career_level` text DEFAULT 'unknown' NOT NULL,
	`note` text,
	`extracted_by` text DEFAULT 'manual' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `job_postings_user_idx` ON `job_postings` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `job_postings_url_uq` ON `job_postings` (`user_id`,`url_key`);--> statement-breakpoint
CREATE TABLE `posting_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`url` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`posting_id` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`posting_id`) REFERENCES `job_postings`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `posting_imports_user_idx` ON `posting_imports` (`user_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `company_resumes` ADD `posting_id` text REFERENCES job_postings(id) ON DELETE set null;--> statement-breakpoint
CREATE INDEX `company_resumes_posting_idx` ON `company_resumes` (`posting_id`);--> statement-breakpoint
ALTER TABLE `diagnoses` ADD `posting_id` text REFERENCES job_postings(id) ON DELETE set null;--> statement-breakpoint
CREATE INDEX `diagnoses_posting_idx` ON `diagnoses` (`posting_id`);