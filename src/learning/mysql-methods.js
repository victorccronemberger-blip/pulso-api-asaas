export function createLearningStoreMethods({ pool, ensureSchema, id, asJson, iso }) {
  async function hasAccess(customerId, courseSlug) {
    await ensureSchema();
    const [[row]] = await pool.query(
      `SELECT 1 allowed
       WHERE EXISTS (
         SELECT 1 FROM orders o JOIN order_items i ON i.order_id=o.id
         WHERE o.customer_id=? AND i.course_slug=?
           AND (o.access_granted_at IS NOT NULL OR o.status='paid' OR o.paid_cents>0)
           AND o.status NOT IN ('failed','refunded','chargeback')
       ) OR EXISTS (
         SELECT 1 FROM enrollments e
         WHERE e.customer_id=? AND e.course_slug=? AND e.status='confirmed'
       ) OR EXISTS (
         SELECT 1 FROM learning_entitlements le
         WHERE le.customer_id=? AND le.course_slug=? AND le.active=1
           AND (le.expires_at IS NULL OR le.expires_at>NOW(3))
       )`,
      [customerId, courseSlug, customerId, courseSlug, customerId, courseSlug],
    );
    return Boolean(row?.allowed);
  }

  return {
    hasCustomerCourseAccess: hasAccess,

    async listCustomerLearningCourses(customerId) {
      await ensureSchema();
      const [rows] = await pool.query(
        `SELECT lc.course_slug AS slug,lc.title,lc.description,
                COUNT(DISTINCT l.id) AS lessonCount,
                COUNT(DISTINCT CASE WHEN p.completed=1 THEN l.id END) AS completedLessons,
                COALESCE(SUM(l.duration_seconds),0) AS durationSeconds,
                MAX(p.updated_at) AS lastActivityAt
         FROM learning_courses lc
         LEFT JOIN learning_lessons l ON l.course_slug=lc.course_slug AND l.published=1
         LEFT JOIN learning_progress p ON p.lesson_id=l.id AND p.customer_id=?
         WHERE lc.active=1 AND (
           EXISTS (SELECT 1 FROM orders o JOIN order_items i ON i.order_id=o.id
             WHERE o.customer_id=? AND i.course_slug=lc.course_slug
               AND (o.access_granted_at IS NOT NULL OR o.status='paid' OR o.paid_cents>0)
               AND o.status NOT IN ('failed','refunded','chargeback'))
           OR EXISTS (SELECT 1 FROM enrollments e
             WHERE e.customer_id=? AND e.course_slug=lc.course_slug AND e.status='confirmed')
           OR EXISTS (SELECT 1 FROM learning_entitlements le
             WHERE le.customer_id=? AND le.course_slug=lc.course_slug AND le.active=1
               AND (le.expires_at IS NULL OR le.expires_at>NOW(3)))
         )
         GROUP BY lc.course_slug,lc.title,lc.description ORDER BY lc.title`,
        [customerId, customerId, customerId, customerId],
      );
      return rows.map((row) => ({
        ...row,
        lessonCount: Number(row.lessonCount),
        completedLessons: Number(row.completedLessons),
        durationSeconds: Number(row.durationSeconds),
        lastActivityAt: iso(row.lastActivityAt),
      }));
    },

    async getCustomerLearningCourse(customerId, courseSlug) {
      await ensureSchema();
      if (!await hasAccess(customerId, courseSlug)) return null;
      const [[course]] = await pool.query(
        "SELECT course_slug AS slug,title,description FROM learning_courses WHERE course_slug=? AND active=1",
        [courseSlug],
      );
      if (!course) return null;
      const [modules] = await pool.query(
        "SELECT id,title,summary,sort_order AS sortOrder FROM learning_modules WHERE course_slug=? ORDER BY sort_order",
        [courseSlug],
      );
      const [lessons] = await pool.query(
        `SELECT l.id,l.module_id AS moduleId,l.title,l.duration_seconds AS durationSeconds,l.material_path AS materialPath,l.sort_order AS sortOrder,
                COALESCE(p.position_seconds,0) AS positionSeconds,COALESCE(p.completed,0) AS completed
         FROM learning_lessons l LEFT JOIN learning_progress p ON p.lesson_id=l.id AND p.customer_id=?
         WHERE l.course_slug=? AND l.published=1 ORDER BY l.sort_order`,
        [customerId, courseSlug],
      );
      const [quizzes] = await pool.query(
        `SELECT q.id,q.lesson_id AS lessonId,q.title,q.kind,q.time_limit_minutes AS timeLimitMinutes,
                q.passing_score_bps AS passingScoreBps,q.sort_order AS sortOrder,COUNT(qq.id) AS questionCount
         FROM learning_quizzes q LEFT JOIN learning_questions qq ON qq.quiz_id=q.id
         WHERE q.course_slug=? AND q.published=1
         GROUP BY q.id,q.lesson_id,q.title,q.kind,q.time_limit_minutes,q.passing_score_bps,q.sort_order
         ORDER BY q.sort_order`,
        [courseSlug],
      );
      const lessonRows = lessons.map((row) => ({
        id: row.id,
        moduleId: Number(row.moduleId),
        title: row.title,
        durationSeconds: Number(row.durationSeconds),
        sortOrder: Number(row.sortOrder),
        positionSeconds: Number(row.positionSeconds),
        completed: Boolean(row.completed),
        hasMaterial: Boolean(row.materialPath),
      }));
      return {
        ...course,
        modules: modules.map((module) => ({
          ...module,
          id: Number(module.id),
          sortOrder: Number(module.sortOrder),
          lessons: lessonRows.filter((lesson) => lesson.moduleId === Number(module.id)),
        })),
        quizzes: quizzes.map((quiz) => ({
          ...quiz,
          timeLimitMinutes: quiz.timeLimitMinutes === null ? null : Number(quiz.timeLimitMinutes),
          passingScoreBps: Number(quiz.passingScoreBps),
          sortOrder: Number(quiz.sortOrder),
          questionCount: Number(quiz.questionCount),
        })),
      };
    },

    async getCustomerLearningLesson(customerId, courseSlug, lessonId) {
      await ensureSchema();
      if (!await hasAccess(customerId, courseSlug)) return null;
      const [[row]] = await pool.query(
        `SELECT l.id,l.course_slug AS courseSlug,l.title,l.bunny_video_id AS bunnyVideoId,
                l.duration_seconds AS durationSeconds,l.material_path AS materialPath,
                COALESCE(p.position_seconds,0) AS positionSeconds,COALESCE(p.completed,0) AS completed
         FROM learning_lessons l LEFT JOIN learning_progress p ON p.lesson_id=l.id AND p.customer_id=?
         WHERE l.course_slug=? AND l.id=? AND l.published=1`,
        [customerId, courseSlug, lessonId],
      );
      return row ? {
        ...row,
        durationSeconds: Number(row.durationSeconds),
        positionSeconds: Number(row.positionSeconds),
        completed: Boolean(row.completed),
      } : null;
    },

    async saveCustomerLessonProgress(customerId, courseSlug, lessonId, value) {
      await ensureSchema();
      if (!await hasAccess(customerId, courseSlug)) return null;
      const [[lesson]] = await pool.query(
        "SELECT duration_seconds AS durationSeconds FROM learning_lessons WHERE id=? AND course_slug=? AND published=1",
        [lessonId, courseSlug],
      );
      if (!lesson) return null;
      const maximum = Math.max(0, Number(lesson.durationSeconds));
      const requested = Math.max(0, Number(value.positionSeconds) || 0);
      const positionSeconds = Math.floor(maximum ? Math.min(requested, maximum) : requested);
      const completed = Boolean(value.completed || (maximum > 0 && positionSeconds >= maximum - 20));
      await pool.query(
        `INSERT INTO learning_progress (customer_id,lesson_id,position_seconds,completed) VALUES (?,?,?,?)
         ON DUPLICATE KEY UPDATE position_seconds=GREATEST(position_seconds,VALUES(position_seconds)),
         completed=GREATEST(completed,VALUES(completed)),updated_at=NOW(3)`,
        [customerId, lessonId, positionSeconds, completed ? 1 : 0],
      );
      return { lessonId, positionSeconds, completed };
    },

    async getCustomerLearningQuiz(customerId, quizId) {
      await ensureSchema();
      const [[quiz]] = await pool.query(
        `SELECT id,course_slug AS courseSlug,lesson_id AS lessonId,title,kind,time_limit_minutes AS timeLimitMinutes,
                passing_score_bps AS passingScoreBps FROM learning_quizzes WHERE id=? AND published=1`,
        [quizId],
      );
      if (!quiz || !await hasAccess(customerId, quiz.courseSlug)) return null;
      const [questions] = await pool.query(
        "SELECT id,prompt,sort_order AS sortOrder FROM learning_questions WHERE quiz_id=? ORDER BY sort_order",
        [quizId],
      );
      const options = questions.length ? (await pool.query(
        `SELECT id,question_id AS questionId,body,sort_order AS sortOrder FROM learning_question_options
         WHERE question_id IN (${questions.map(() => "?").join(",")}) ORDER BY question_id,sort_order`,
        questions.map((question) => question.id),
      ))[0] : [];
      return {
        ...quiz,
        timeLimitMinutes: quiz.timeLimitMinutes === null ? null : Number(quiz.timeLimitMinutes),
        passingScoreBps: Number(quiz.passingScoreBps),
        questions: questions.map((question) => ({
          id: Number(question.id),
          prompt: question.prompt,
          sortOrder: Number(question.sortOrder),
          options: options.filter((option) => Number(option.questionId) === Number(question.id)).map((option) => ({
            id: Number(option.id), body: option.body, sortOrder: Number(option.sortOrder),
          })),
        })),
      };
    },

    async submitCustomerLearningQuiz(customerId, quizId, answers) {
      await ensureSchema();
      const quiz = await this.getCustomerLearningQuiz(customerId, quizId);
      if (!quiz) return null;
      const [rows] = await pool.query(
        `SELECT q.id AS questionId,q.explanation,o.id AS optionId,o.is_correct AS isCorrect
         FROM learning_questions q JOIN learning_question_options o ON o.question_id=q.id
         WHERE q.quiz_id=? ORDER BY q.sort_order,o.sort_order`,
        [quizId],
      );
      const selected = new Map((Array.isArray(answers) ? answers : []).map((answer) => [Number(answer.questionId), Number(answer.optionId)]));
      const questionIds = [...new Set(rows.map((row) => Number(row.questionId)))];
      const details = questionIds.map((questionId) => {
        const selectedOptionId = selected.get(questionId) ?? null;
        const correctOptionId = Number(rows.find((row) => Number(row.questionId) === questionId && row.isCorrect)?.optionId ?? 0) || null;
        const explanation = rows.find((row) => Number(row.questionId) === questionId)?.explanation ?? null;
        return { questionId, selectedOptionId, correctOptionId, correct: selectedOptionId === correctOptionId, explanation };
      });
      const correctAnswers = details.filter((item) => item.correct).length;
      const totalQuestions = questionIds.length;
      const scoreBps = totalQuestions ? Math.round(correctAnswers * 10_000 / totalQuestions) : 0;
      const attemptId = id();
      await pool.query(
        "INSERT INTO learning_quiz_attempts (id,customer_id,quiz_id,correct_answers,total_questions,score_bps,answers_json) VALUES (?,?,?,?,?,?,?)",
        [attemptId, customerId, quizId, correctAnswers, totalQuestions, scoreBps, asJson(details)],
      );
      return { attemptId, correctAnswers, totalQuestions, scoreBps, passed: scoreBps >= quiz.passingScoreBps, answers: details };
    },

    async listCustomerLearningAttempts(customerId, courseSlug) {
      await ensureSchema();
      const [rows] = await pool.query(
        `SELECT a.id AS attemptId,a.quiz_id AS quizId,q.title,q.kind,a.correct_answers AS correctAnswers,
                a.total_questions AS totalQuestions,a.score_bps AS scoreBps,a.completed_at AS completedAt
         FROM learning_quiz_attempts a JOIN learning_quizzes q ON q.id=a.quiz_id
         WHERE a.customer_id=? AND q.course_slug=? ORDER BY a.completed_at DESC LIMIT 100`,
        [customerId, courseSlug],
      );
      return rows.map((row) => ({ ...row, correctAnswers: Number(row.correctAnswers), totalQuestions: Number(row.totalQuestions), scoreBps: Number(row.scoreBps), completedAt: iso(row.completedAt) }));
    },
  };
}
