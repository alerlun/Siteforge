import { Outlet } from 'react-router-dom';
import Sidebar from '../components/Sidebar.jsx';

export default function AppLayout() {
  return (
    <div className="min-h-screen flex bg-bg">
      <Sidebar />
      <main className="flex-1 min-w-0 flex flex-col">
        <Outlet />
      </main>
    </div>
  );
}
