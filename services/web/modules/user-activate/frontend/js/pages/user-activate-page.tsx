import { renderInReactLayout } from '@/react'

import UserActivateRegister from '../components/user-activate-register'
import Signup from '../components/signup'

// The same container renders the admin bulk-registration tool on
// /admin/register and the public single-email signup on /register.
const isAdmin = window.location.pathname.startsWith('/admin/')

renderInReactLayout('user-activate-register-container', () =>
  isAdmin ? <UserActivateRegister /> : <Signup />
)
