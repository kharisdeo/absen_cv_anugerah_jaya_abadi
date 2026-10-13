/** Prevents concurrent submissions from rapid clicks or overlapping event handlers. */
export class AttendanceSubmitGate {
  private active = false;

  async run<T>(operation: () => Promise<T>): Promise<T | null> {
    if (this.active) return null;
    this.active = true;
    try {
      return await operation();
    } finally {
      this.active = false;
    }
  }
}
