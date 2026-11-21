import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Save, KeyRound, Sun, Moon } from 'lucide-react';
import { apiRequest } from '../api/client.ts';
import { useAuth } from '../context/AuthContext.tsx';
import { useTheme } from '../context/ThemeContext.tsx';
import { useToast } from '../context/ToastContext.tsx';
import type { User, UserPreferences } from '../types.ts';

const ALL_ORGS = [
  'upsc',
  'ssc',
  'sbi',
  'ibps',
  'rrbcdg',
  'nta',
  'tnpsc',
  'indiapost',
];

const ALL_CATEGORIES = [
  'Civil Services',
  'Public Sector Banking',
  'Central Group B & C',
  'State Civil Services',
  'Railway Recruitment',
  'Higher Education & Testing',
  'Postal Services',
];

const ALL_PRIORITIES = ['Critical', 'High', 'Normal', 'Low'];

export function ProfilePage() {
  const { user, refreshUser } = useAuth();
  const { darkMode, setDarkMode } = useTheme();
  const { showToast } = useToast();

  const [fullName, setFullName] = useState('');
  const [qualification, setQualification] = useState('Graduate');
  const [targetOrgs, setTargetOrgs] = useState<string[]>([]);
  const [targetExams, setTargetExams] = useState('');
  const [jobCategories, setJobCategories] = useState<string[]>([]);
  const [preferredStates, setPreferredStates] = useState('All India');
  const [alertPriorities, setAlertPriorities] = useState<string[]>(['Critical', 'High', 'Normal']);
  const [savedOnlyAlerts, setSavedOnlyAlerts] = useState(false);
  const [emailAlerts, setEmailAlerts] = useState(true);
  const [pageSize, setPageSize] = useState(12);
  const [saving, setSaving] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [changingPass, setChangingPass] = useState(false);

  useEffect(() => {
    if (!user) return;
    apiRequest<{ user: User; preferences: UserPreferences }>('/profile')
      .then(({ user: u, preferences: p }) => {
        setFullName(u.full_name);
        setQualification(p.qualification || 'Graduate');
        setTargetOrgs(p.target_organizations || []);
        setTargetExams((p.target_exams || []).join(', '));
        setJobCategories(p.job_categories || []);
        setPreferredStates((p.preferred_states || ['All India']).join(', '));
        setAlertPriorities(p.alert_priorities || ['Critical', 'High', 'Normal']);
        setSavedOnlyAlerts(Boolean(p.saved_only_alerts));
        setEmailAlerts(Boolean(p.email_alerts_enabled));
        setPageSize(p.dashboard_page_size || 12);
      })
      .catch(() => {});
  }, [user?.id]);

  if (!user) {
    return (
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-10 text-center space-y-3">
        <h1 className="text-lg font-bold text-slate-900 dark:text-white">Sign in to manage Profile &amp; Preferences</h1>
        <Link to="/login" className="inline-block px-4 py-2 rounded-lg bg-blue-700 text-white text-xs font-semibold">
          Sign In
        </Link>
      </div>
    );
  }

  const toggleItem = (list: string[], setList: React.Dispatch<React.SetStateAction<string[]>>, val: string) => {
    setList((prev) => (prev.includes(val) ? prev.filter((x) => x !== val) : [...prev, val]));
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await apiRequest('/profile', {
        method: 'PUT',
        body: JSON.stringify({
          full_name: fullName,
          qualification,
          target_organizations: targetOrgs,
          target_exams: targetExams
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          job_categories: jobCategories,
          preferred_states: preferredStates
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          alert_priorities: alertPriorities,
          saved_only_alerts: savedOnlyAlerts,
          email_alerts_enabled: emailAlerts,
          dark_mode: darkMode,
          dashboard_page_size: pageSize,
        }),
      });
      await refreshUser();
      showToast('Profile and personalized tracking preferences saved.', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to save preferences', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    setChangingPass(true);
    try {
      await apiRequest('/profile/password', {
        method: 'PUT',
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
      });
      setCurrentPassword('');
      setNewPassword('');
      showToast('Password updated successfully.', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Password change failed', 'error');
    } finally {
      setChangingPass(false);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
          Profile &amp; Alert Preferences
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
          Configure personalized opportunity matching, alert priorities, and appearance settings.
        </p>
      </div>

      <form onSubmit={handleSaveProfile} className="space-y-6">
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4">
          <h2 className="text-sm font-bold text-slate-900 dark:text-white">Account Identity</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">Full Name</label>
              <input
                type="text"
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">Email</label>
              <input
                type="email"
                disabled
                value={user.email}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/50 text-sm text-slate-500"
              />
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4">
          <h2 className="text-sm font-bold text-slate-900 dark:text-white">
            Personalized Tracker Criteria (My Opportunities)
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                Highest Qualification
              </label>
              <select
                value={qualification}
                onChange={(e) => setQualification(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm"
              >
                <option value="10th Pass">10th Pass</option>
                <option value="12th Pass">12th Pass</option>
                <option value="Graduate">Graduate / Any Degree</option>
                <option value="B.E. / B.Tech">Engineering (B.E. / B.Tech)</option>
                <option value="Post Graduate">Post Graduate</option>
                <option value="MBBS">MBBS / Medical</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                Preferred States / Regions (comma-separated)
              </label>
              <input
                type="text"
                value={preferredStates}
                onChange={(e) => setPreferredStates(e.target.value)}
                placeholder="All India, Tamil Nadu, Kerala"
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
              Target Examinations Keywords (comma-separated)
            </label>
            <input
              type="text"
              value={targetExams}
              onChange={(e) => setTargetExams(e.target.value)}
              placeholder="Civil Services, Combined Graduate Level, Probationary Officer, Grade B"
              className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-2">
              Target Organizations
            </label>
            <div className="flex flex-wrap gap-2">
              {ALL_ORGS.map((org) => {
                const active = targetOrgs.includes(org);
                return (
                  <button
                    key={org}
                    type="button"
                    onClick={() => toggleItem(targetOrgs, setTargetOrgs, org)}
                    className={`px-2.5 py-1 rounded-md border text-xs font-semibold uppercase transition-colors ${
                      active
                        ? 'border-blue-600 bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300'
                        : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    {org}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-2">
              Preferred Job Categories
            </label>
            <div className="flex flex-wrap gap-2">
              {ALL_CATEGORIES.map((cat) => {
                const active = jobCategories.includes(cat);
                return (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => toggleItem(jobCategories, setJobCategories, cat)}
                    className={`px-2.5 py-1 rounded-md border text-xs font-medium transition-colors ${
                      active
                        ? 'border-blue-600 bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300'
                        : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    {cat}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4">
          <h2 className="text-sm font-bold text-slate-900 dark:text-white">Alert &amp; Dashboard Preferences</h2>

          <div>
            <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-2">
              Alert Priorities to Receive
            </label>
            <div className="flex flex-wrap gap-2">
              {ALL_PRIORITIES.map((p) => {
                const active = alertPriorities.includes(p);
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => toggleItem(alertPriorities, setAlertPriorities, p)}
                    className={`px-3 py-1 rounded-md border text-xs font-semibold transition-colors ${
                      active
                        ? 'border-blue-600 bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300'
                        : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    {p}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
            <label className="flex items-center gap-2 text-xs font-medium cursor-pointer">
              <input
                type="checkbox"
                checked={emailAlerts}
                onChange={(e) => setEmailAlerts(e.target.checked)}
              />
              <span>Email change alerts enabled</span>
            </label>

            <label className="flex items-center gap-2 text-xs font-medium cursor-pointer">
              <input
                type="checkbox"
                checked={savedOnlyAlerts}
                onChange={(e) => setSavedOnlyAlerts(e.target.checked)}
              />
              <span>Prioritize bookmarked jobs only</span>
            </label>

            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Page Size:</span>
              <select
                value={pageSize}
                onChange={(e) => setPageSize(Number(e.target.value))}
                className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs"
              >
                <option value={8}>8</option>
                <option value={12}>12</option>
                <option value={20}>20</option>
                <option value={30}>30</option>
              </select>
            </div>
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-slate-800">
            <div>
              <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">Appearance Mode</div>
              <div className="text-[11px] text-slate-500">Toggle between Light and Dark theme</div>
            </div>
            <button
              type="button"
              onClick={() => setDarkMode(!darkMode)}
              className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold flex items-center gap-1.5"
            >
              {darkMode ? <Sun className="w-3.5 h-3.5 text-amber-400" /> : <Moon className="w-3.5 h-3.5" />}
              <span>{darkMode ? 'Dark Mode On' : 'Light Mode On'}</span>
            </button>
          </div>
        </div>

        <button
          type="submit"
          disabled={saving}
          className="px-5 py-2.5 rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-60 text-white text-sm font-semibold flex items-center gap-2"
        >
          <Save className="w-4 h-4" />
          <span>{saving ? 'Saving...' : 'Save Preferences'}</span>
        </button>
      </form>

      {/* Change Password */}
      <form
        onSubmit={handlePasswordChange}
        className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4"
      >
        <h2 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-blue-600" />
          <span>Change Password</span>
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <input
            type="password"
            required
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            placeholder="Current password"
            className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm"
          />
          <input
            type="password"
            required
            minLength={6}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="New password (min 6 chars)"
            className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm"
          />
        </div>
        <button
          type="submit"
          disabled={changingPass}
          className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold hover:bg-slate-50 dark:hover:bg-slate-800"
        >
          {changingPass ? 'Updating...' : 'Update Password'}
        </button>
      </form>
    </div>
  );
}
