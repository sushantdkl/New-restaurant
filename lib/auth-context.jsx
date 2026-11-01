'use client'

import { createContext, useContext, useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { isRoleEnabled, FEATURES, PRIMARY_ROUTE } from '@/lib/deployment'

const AuthContext = createContext({})

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [token, setToken] = useState(null)
  const [loading, setLoading] = useState(true)
  const router = useRouter()

  const getDeviceId = () => {
    let deviceId = localStorage.getItem('pos_device_id')
    if (!deviceId) {
      deviceId = `device_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      localStorage.setItem('pos_device_id', deviceId)
    }
    return deviceId
  }

  useEffect(() => {
    // Check for existing session
    const storedToken = localStorage.getItem('pos_token')
    const storedUser = localStorage.getItem('pos_user')
    
    let user = null
    try { user = storedUser ? JSON.parse(storedUser) : null } catch { /* corrupt entry: sign in again */ }
    if (storedToken && user) {
      verifySession(storedToken, user)
    } else {
      setLoading(false)
    }
  }, [])

  const verifySession = async (storedToken, storedUser) => {
    try {
      const response = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: storedToken }),
        signal: AbortSignal.timeout(3000) // 3 second timeout
      })

      if (response.ok) {
        const data = await response.json()
        if (data.valid) {
          setToken(storedToken)
          setUser(storedUser)
        } else {
          logout()
        }
      } else {
        logout()
      }
    } catch (error) {
      console.error('Session verification failed:', error)
      // Clear invalid session
      localStorage.removeItem('pos_token')
      localStorage.removeItem('pos_user')
    } finally {
      setLoading(false)
    }
  }

  const login = async (username, pin) => {
    try {
      const deviceId = getDeviceId()
      
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, pin, deviceId })
      })

      const data = await response.json()

      if (response.ok && data.success) {
        // Single-admin deployment: reject any role not enabled in this profile.
        if (!isRoleEnabled(data.user.role)) {
          try {
            await fetch('/api/auth/logout', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: data.token }),
            })
          } catch { /* ignore */ }
          return {
            success: false,
            error: 'This account is not permitted to sign in to this system.',
          }
        }

        localStorage.setItem('pos_token', data.token)
        localStorage.setItem('pos_user', JSON.stringify(data.user))
        setToken(data.token)
        setUser(data.user)

        if (data.user.must_change_password || data.must_change_password) {
          router.push('/admin/settings?changePin=1')
          return { success: true, must_change_password: true }
        }

        // Redirect based on role
        redirectByRole(data.user.role)

        return { success: true }
      } else {
        return { success: false, error: data.error || 'Login failed' }
      }
    } catch (error) {
      console.error('Login error:', error)
      return { success: false, error: 'Network error' }
    }
  }

  const logout = async () => {
    if (token) {
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        })
      } catch (error) {
        console.error('Logout error:', error)
      }
    }

    localStorage.removeItem('pos_token')
    localStorage.removeItem('pos_user')
    setToken(null)
    setUser(null)
    router.push('/login')
  }

  const redirectByRole = (role) => {
    // Counter deployment: admin lands directly on the fast New Sale screen.
    if (role === 'admin') {
      router.push(PRIMARY_ROUTE)
      return
    }
    if (FEATURES.staffRoleLogin) {
      const routes = { waiter: '/waiter', cashier: '/cashier', kitchen: '/kitchen' }
      router.push(routes[role] || '/login')
      return
    }
    router.push('/login')
  }

  const apiCall = async (url, options = {}) => {
    const authToken =
      token ||
      (typeof window !== 'undefined' ? localStorage.getItem('pos_token') : null)

    const headers = {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...options.headers,
    }

    const response = await fetch(url, {
      ...options,
      headers,
    })

    if (response.status === 401) {
      // Only force logout when we actually sent a token (session expired)
      if (authToken) {
        logout()
      }
      throw new Error('Unauthorized')
    }

    return response
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        loading,
        login,
        logout,
        apiCall,
        isAuthenticated: !!user && !!token,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return context
}
