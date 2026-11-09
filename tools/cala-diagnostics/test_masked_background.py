import unittest
import importlib.util
import numpy as np
HAS_SCIPY = bool(importlib.util.find_spec("scipy"))
if HAS_SCIPY:
    from scipy.optimize import lsq_linear
    from masked_background import MaskedBackgroundKeep

@unittest.skipUnless(HAS_SCIPY, "optional SciPy is not installed")
class MaskedBackgroundTests(unittest.TestCase):
    def setup_arm(self):
        rng=np.random.default_rng(43); n=225
        a=rng.uniform(.1,1,(n,3)); a[:,0]=0; a.reshape(15,15,3)[6:9,6:9,0]=rng.uniform(.2,1,(3,3))
        b=np.column_stack((np.ones(n),rng.normal(size=n)))
        y=a@np.array([2.,.7,1.1])+b@np.array([.4,-.2])+rng.normal(0,.1,n)
        arm=MaskedBackgroundKeep(a,b,0,(15,15),np.ones(n),np.ones(n),0)
        return arm,y
    def test_independent_bounded_ls_and_freeze(self):
        arm,y=self.setup_arm(); r=arm.solve(y)
        x=np.column_stack((arm.outside_neighbors,arm.b[arm.outside]))
        lo=np.r_[np.zeros(arm.outside_neighbors.shape[1]),np.full(arm.b.shape[1],-np.inf)]
        fit=lsq_linear(x,y[arm.outside],bounds=(lo,np.full(x.shape[1],np.inf)),tol=1e-13)
        np.testing.assert_allclose(r['beta'],fit.x[-arm.b.shape[1]:],atol=1e-8)
        np.testing.assert_array_equal(r['frozen_background_full'],r['frozen_background_reduced'])
        z=y[arm.mask]-r['frozen_background_full']; am=arm.a[arm.mask]
        ff=lsq_linear(am,z,bounds=(0,np.inf),tol=1e-13)
        rr=lsq_linear(am[:,arm.keep],z,bounds=(0,np.inf),tol=1e-13)
        self.assertAlmostEqual(r['raw_gain'],np.sum((z-am[:,arm.keep]@rr.x)**2)-np.sum((z-am@ff.x)**2),places=8)
    def test_injection_does_not_change_outside_fit(self):
        arm,y=self.setup_arm(); r=arm.solve(y); s=arm.solve(y+100*arm.a[:,0])
        np.testing.assert_array_equal(r['beta'],s['beta'])
        self.assertEqual(arm.diagnostics['target_outside_energy'],0)
    def test_rank_guard(self):
        arm,y=self.setup_arm()
        with self.assertRaisesRegex(ValueError,'unidentifiable'):
            MaskedBackgroundKeep(arm.a,np.column_stack((arm.b[:,0],arm.b[:,0])),0,(15,15),np.ones(225),np.ones(225))
    def test_batch_scalar(self):
        arm,y=self.setup_arm(); ys=np.stack([y,y+2*arm.a[:,0]])
        for a,b in zip(arm.solve_many(ys),[arm.solve(row) for row in ys]):
            for key in ('raw_gain','raw_full','raw_red','outside_rss'):
                self.assertAlmostEqual(a[key],b[key],places=8)
            np.testing.assert_allclose(a['beta'],b['beta'],atol=1e-12)
    def test_background_confounding_guard(self):
        arm,y=self.setup_arm()
        with self.assertRaisesRegex(ValueError,'unidentifiable'):
            MaskedBackgroundKeep(arm.a,arm.a[:,1:2],0,(15,15),np.ones(225),np.ones(225))
    def test_zero_outside_neighbor_retained_inside(self):
        arm,y=self.setup_arm(); a=arm.a.copy(); a[:,1]=a[:,0]*.5
        s=MaskedBackgroundKeep(a,arm.b,0,(15,15),np.ones(225),np.ones(225))
        self.assertEqual(s.diagnostics['dropped_zero_outside_neighbors'],1)
        self.assertEqual(len(s.solve(y)['c']),3)
if __name__=='__main__': unittest.main()
