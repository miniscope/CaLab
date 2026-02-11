use crate::Solver;

impl Solver {
    /// Run n_steps of FISTA. Returns true if converged.
    /// Full implementation in Task 2.
    pub fn step_batch(&mut self, _n_steps: u32) -> bool {
        self.converged
    }
}
