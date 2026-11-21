import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext.tsx';
import { ThemeProvider } from './context/ThemeContext.tsx';
import { ToastProvider } from './context/ToastContext.tsx';
import { Layout } from './components/Layout.tsx';
import { DashboardPage } from './pages/DashboardPage.tsx';
import { OpportunitiesPage } from './pages/OpportunitiesPage.tsx';
import { NotificationsPage } from './pages/NotificationsPage.tsx';
import { NotificationDetailsPage } from './pages/NotificationDetailsPage.tsx';
import { CalendarPage } from './pages/CalendarPage.tsx';
import { ChangeHistoryPage } from './pages/ChangeHistoryPage.tsx';
import { SourcesPage } from './pages/SourcesPage.tsx';
import { AlertsPage } from './pages/AlertsPage.tsx';
import { SavedPage } from './pages/SavedPage.tsx';
import { ProfilePage } from './pages/ProfilePage.tsx';
import { AdminPage } from './pages/AdminPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { RegisterPage } from './pages/RegisterPage.tsx';

export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AuthProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/register" element={<RegisterPage />} />
              <Route
                path="/*"
                element={
                  <Layout>
                    <Routes>
                      <Route path="/" element={<DashboardPage />} />
                      <Route path="/opportunities" element={<OpportunitiesPage />} />
                      <Route path="/notifications" element={<NotificationsPage />} />
                      <Route path="/notifications/:id" element={<NotificationDetailsPage />} />
                      <Route path="/calendar" element={<CalendarPage />} />
                      <Route path="/changes" element={<ChangeHistoryPage />} />
                      <Route path="/sources" element={<SourcesPage />} />
                      <Route path="/alerts" element={<AlertsPage />} />
                      <Route path="/saved" element={<SavedPage />} />
                      <Route path="/profile" element={<ProfilePage />} />
                      <Route path="/admin" element={<AdminPage />} />
                      <Route path="*" element={<Navigate to="/" replace />} />
                    </Routes>
                  </Layout>
                }
              />
            </Routes>
          </BrowserRouter>
        </AuthProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
