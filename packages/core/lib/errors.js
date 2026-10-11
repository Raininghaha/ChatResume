/**
 * 带退出码语义的错误。
 *
 * CLI 直接把它映射成进程退出码，HTTP 层把它映射成状态码，所以两种调用方
 * 都能拿到「为什么失败」的结构化答案，而不是去 grep 错误文案。
 */
export class ResumeError extends Error {
  /**
   * @param {string} message 给人看的中文说明
   * @param {string} code 机器可读的错误码，如 NO_RESUME / BUSY
   * @param {number} status HTTP 状态码
   * @param {number} exitCode 进程退出码
   */
  constructor(message, code = 'ERROR', status = 400, exitCode = 1) {
    super(message);
    this.name = 'ResumeError';
    this.code = code;
    this.status = status;
    this.exitCode = exitCode;
  }
}

export const EXIT = {
  OK: 0,
  CHECK_FAILED: 1,
  USAGE: 2,
  ENVIRONMENT: 3,
};
