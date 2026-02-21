-- Admin role helper and moderation policies.
-- Admin designation: manually set app_metadata.role = 'admin'
-- via Supabase Dashboard or service_role API call.

-- Helper function to check admin role from JWT
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(auth.jwt()->'app_metadata'->>'role', '') = 'admin'
$$;

-- Admin moderation: allow admins to delete community submissions
CREATE POLICY "Admins can delete submissions"
  ON catune_submissions FOR DELETE
  TO authenticated
  USING (public.is_admin());
