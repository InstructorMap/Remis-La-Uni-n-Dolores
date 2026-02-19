import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  ScrollView
} from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import MapView, { Marker, Polyline } from 'react-native-maps';
import * as Location from 'expo-location';
import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { io } from 'socket.io-client';

const Stack = createStackNavigator();

// ============================================
// SUPABASE CONFIG
// ============================================
const SUPABASE_URL = 'https://tu-proyecto.supabase.co';
const SUPABASE_KEY = 'tu-anon-key';
const SERVER_URL = 'http://localhost:3000'; // Cambiar por IP local

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { storage: AsyncStorage, autoRefreshToken: true, persistSession: true }
});

// ============================================
// MAIN APP
// ============================================
export default function App() {
  const [user, setUser] = useState(null);
  const [userRole, setUserRole] = useState('passenger');

  useEffect(() => {
    checkUser();
  }, []);

  const checkUser = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .single();
      setUser(profile);
      setUserRole(profile?.current_role || 'passenger');
    }
  };

  const handleLogin = (userData) => {
    setUser(userData);
    setUserRole(userData.current_role || 'passenger');
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setUser(null);
  };

  const switchRole = async (role) => {
    const token = (await supabase.auth.getSession()).data.session?.access_token;
    const response = await fetch(`${SERVER_URL}/switch-role`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ role })
    });
    const data = await response.json();
    setUser(data);
    setUserRole(role);
  };

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {!user ? (
          <Stack.Screen name="Login">
            {props => <LoginScreen {...props} onLogin={handleLogin} />}
          </Stack.Screen>
        ) : userRole === 'passenger' ? (
          <Stack.Screen name="Passenger">
            {props => (
              <PassengerScreen 
                {...props} 
                user={user} 
                onLogout={handleLogout} 
                onSwitchRole={() => switchRole('driver')} 
              />
            )}
          </Stack.Screen>
        ) : (
          <Stack.Screen name="Driver">
            {props => (
              <DriverScreen 
                {...props} 
                user={user} 
                onLogout={handleLogout} 
                onSwitchRole={() => switchRole('passenger')} 
              />
            )}
          </Stack.Screen>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

// ============================================
// LOGIN SCREEN
// ============================================
function LoginScreen({ navigation, onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [isRegister, setIsRegister] = useState(false);

  const handleAuth = async () => {
    setLoading(true);
    try {
      if (isRegister) {
        const { data, error } = await supabase.auth.signUp({
          email, password,
          options: { data: { full_name: email.split('@')[0] } }
        });
        if (error) throw error;
        
        if (data.user) {
          await supabase.from('profiles').insert({
            id: data.user.id,
            email: data.user.email,
            full_name: email.split('@')[0],
            current_role: 'passenger'
          });
        }
        Alert.alert('Éxito', 'Registro exitoso, ahora inicia sesión');
        setIsRegister(false);
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        
        const { data: profile } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', data.user.id)
          .single();
        
        onLogin(profile);
      }
    } catch (error) {
      Alert.alert('Error', error.message);
    }
    setLoading(false);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Remisería App</Text>
      <TextInput
        style={styles.input}
        placeholder="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
      />
      <TextInput
        style={styles.input}
        placeholder="Contraseña"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
      />
      <TouchableOpacity style={styles.button} onPress={handleAuth} disabled={loading}>
        <Text style={styles.buttonText}>{loading ? 'Cargando...' : (isRegister ? 'Registrarse' : 'Iniciar Sesión')}</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={() => setIsRegister(!isRegister)}>
        <Text style={styles.link}>
          {isRegister ? '¿Ya tienes cuenta? Inicia sesión' : '¿No tienes cuenta? Regístrate'}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

// ============================================
// PASSENGER SCREEN
// ============================================
function PassengerScreen({ user, onLogout, onSwitchRole }) {
  const [location, setLocation] = useState(null);
  const [pickup, setPickup] = useState(null);
  const [dropoff, setDropoff] = useState(null);
  const [searching, setSearching] = useState(false);
  const [driver, setDriver] = useState(null);
  const [fare, setFare] = useState(null);
  const mapRef = useRef(null);
  const socketRef = useRef(null);

  useEffect(() => {
    getLocation();
    connectSocket();
    return () => socketRef.current?.disconnect();
  }, []);

  const getLocation = async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status === 'granted') {
      const loc = await Location.getCurrentPositionAsync({});
      const pos = { lat: loc.coords.latitude, lng: loc.coords.longitude };
      setLocation(pos);
      setPickup(pos);
    }
  };

  const connectSocket = async () => {
    const token = (await supabase.auth.getSession()).data.session?.access_token;
    socketRef.current = io(SERVER_URL, { auth: { token } });
    
    socketRef.current.on('ride-accepted', (data) => {
      setSearching(false);
      setDriver(data.driverLocation);
      Alert.alert('¡Viaje aceptado!', 'Un conductor ha aceptado tu viaje');
    });
  };

  const selectOnMap = async () => {
    if (!mapRef.current) return;
    const camera = await mapRef.current.getCamera();
    setDropoff({
      lat: camera.center.latitude,
      lng: camera.center.longitude
    });
  };

  const requestRide = () => {
    if (!pickup || !dropoff) {
      Alert.alert('Error', 'Selecciona origen y destino');
      return;
    }
    setSearching(true);
    socketRef.current.emit('request-ride', { pickup, dropoff });
  };

  if (!location) return <ActivityIndicator style={styles.centered} />;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerText}>Pasajero: {user.full_name}</Text>
        <View style={styles.headerButtons}>
          <TouchableOpacity onPress={onSwitchRole} style={styles.switchButton}>
            <Text>🔁 Ser Conductor</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onLogout} style={styles.logoutButton}>
            <Text>🚪</Text>
          </TouchableOpacity>
        </View>
      </View>

      <MapView
        ref={mapRef}
        style={styles.map}
        initialRegion={{
          latitude: location.lat,
          longitude: location.lng,
          latitudeDelta: 0.0922,
          longitudeDelta: 0.0421,
        }}
        onPress={(e) => setDropoff(e.nativeEvent.coordinate)}
      >
        {pickup && <Marker coordinate={pickup} title="Origen" pinColor="green" />}
        {dropoff && <Marker coordinate={dropoff} title="Destino" pinColor="red" />}
        {driver && <Marker coordinate={driver} title="Conductor" pinColor="blue" />}
        {pickup && dropoff && (
          <Polyline
            coordinates={[pickup, dropoff]}
            strokeColor="#000"
            strokeWidth={3}
          />
        )}
      </MapView>

      <View style={styles.controls}>
        {!driver ? (
          <>
            <TouchableOpacity style={styles.mapButton} onPress={selectOnMap}>
              <Text>📍 Marcar destino en mapa</Text>
            </TouchableOpacity>
            
            {pickup && dropoff && (
              <TouchableOpacity 
                style={[styles.rideButton, searching && styles.searching]} 
                onPress={requestRide}
                disabled={searching}
              >
                <Text style={styles.rideButtonText}>
                  {searching ? 'Buscando conductor...' : 'Solicitar Viaje'}
                </Text>
              </TouchableOpacity>
            )}
          </>
        ) : (
          <View style={styles.rideInfo}>
            <Text>🚗 Conductor en camino</Text>
            <TouchableOpacity style={styles.cancelButton}>
              <Text>Cancelar</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </View>
  );
}

// ============================================
// DRIVER SCREEN
// ============================================
function DriverScreen({ user, onLogout, onSwitchRole }) {
  const [location, setLocation] = useState(null);
  const [requests, setRequests] = useState([]);
  const [currentRide, setCurrentRide] = useState(null);
  const socketRef = useRef(null);
  const locationSubscription = useRef(null);

  useEffect(() => {
    setupDriver();
    return () => {
      socketRef.current?.disconnect();
      locationSubscription.current?.remove();
    };
  }, []);

  const setupDriver = async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return;

    // Connect socket
    const token = (await supabase.auth.getSession()).data.session?.access_token;
    socketRef.current = io(SERVER_URL, { auth: { token } });

    // Start location tracking
    locationSubscription.current = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, timeInterval: 5000, distanceInterval: 10 },
      (loc) => {
        const pos = { lat: loc.coords.latitude, lng: loc.coords.longitude };
        setLocation(pos);
        socketRef.current.emit('driver-location', pos);
      }
    );

    // Listen for ride requests
    socketRef.current.on('new-ride-request', (request) => {
      setRequests(prev => [...prev, request]);
    });
  };

  const acceptRide = (request) => {
    socketRef.current.emit('accept-ride', { requestId: request.requestId });
    setCurrentRide(request);
    setRequests([]);
  };

  if (!location) return <ActivityIndicator style={styles.centered} />;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerText}>Conductor: {user.full_name}</Text>
        <View style={styles.headerButtons}>
          <TouchableOpacity onPress={onSwitchRole} style={styles.switchButton}>
            <Text>🔁 Ser Pasajero</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onLogout} style={styles.logoutButton}>
            <Text>🚪</Text>
          </TouchableOpacity>
        </View>
      </View>

      <MapView
        style={styles.map}
        initialRegion={{
          latitude: location.lat,
          longitude: location.lng,
          latitudeDelta: 0.0922,
          longitudeDelta: 0.0421,
        }}
      >
        <Marker coordinate={location} title="Tu ubicación" pinColor="blue" />
        {requests.map((req, idx) => (
          <Marker 
            key={idx}
            coordinate={req.pickup}
            title={`Solicitud #${idx+1}`}
            pinColor="orange"
          />
        ))}
      </MapView>

      <View style={styles.requestsPanel}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {requests.map((req, idx) => (
            <View key={idx} style={styles.requestCard}>
              <Text>💰 ${req.fare.total}</Text>
              <Text>📍 {req.pickup.lat.toFixed(4)}</Text>
              <TouchableOpacity 
                style={styles.acceptButton}
                onPress={() => acceptRide(req)}
              >
                <Text>Aceptar</Text>
              </TouchableOpacity>
            </View>
          ))}
        </ScrollView>
      </View>

      {currentRide && (
        <View style={styles.currentRide}>
          <Text>Viaje en curso - Destino: {currentRide.dropoff.lat.toFixed(4)}</Text>
          <TouchableOpacity style={styles.completeButton}>
            <Text>Completar Viaje</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

// ============================================
// STYLES
// ============================================
const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center'
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 10,
    backgroundColor: '#f5f5f5',
    borderBottomWidth: 1,
    borderBottomColor: '#ddd',
    marginTop: 30
  },
  headerText: {
    fontSize: 14,
    fontWeight: 'bold'
  },
  headerButtons: {
    flexDirection: 'row'
  },
  switchButton: {
    backgroundColor: '#e0e0e0',
    padding: 8,
    borderRadius: 5,
    marginRight: 10
  },
  logoutButton: {
    backgroundColor: '#ff6b6b',
    padding: 8,
    borderRadius: 5
  },
  map: {
    flex: 1
  },
  controls: {
    position: 'absolute',
    bottom: 20,
    left: 20,
    right: 20
  },
  mapButton: {
    backgroundColor: 'white',
    padding: 15,
    borderRadius: 10,
    alignItems: 'center',
    marginBottom: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
    elevation: 5
  },
  rideButton: {
    backgroundColor: '#4CAF50',
    padding: 15,
    borderRadius: 10,
    alignItems: 'center'
  },
  searching: {
    backgroundColor: '#ff9800'
  },
  rideButtonText: {
    color: 'white',
    fontWeight: 'bold'
  },
  rideInfo: {
    backgroundColor: 'white',
    padding: 15,
    borderRadius: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  cancelButton: {
    backgroundColor: '#ff4444',
    padding: 8,
    borderRadius: 5
  },
  requestsPanel: {
    position: 'absolute',
    top: 80,
    left: 10,
    right: 10
  },
  requestCard: {
    backgroundColor: 'white',
    padding: 15,
    borderRadius: 10,
    marginRight: 10,
    minWidth: 150,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
    elevation: 5
  },
  acceptButton: {
    backgroundColor: '#4CAF50',
    padding: 8,
    borderRadius: 5,
    marginTop: 10,
    alignItems: 'center'
  },
  currentRide: {
    position: 'absolute',
    bottom: 20,
    left: 20,
    right: 20,
    backgroundColor: '#2196F3',
    padding: 15,
    borderRadius: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  completeButton: {
    backgroundColor: 'white',
    padding: 8,
    borderRadius: 5
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 30,
    textAlign: 'center'
  },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    padding: 15,
    marginBottom: 15,
    borderRadius: 8,
    fontSize: 16
  },
  button: {
    backgroundColor: '#4CAF50',
    padding: 15,
    borderRadius: 8,
    alignItems: 'center',
    marginBottom: 15
  },
  buttonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: 'bold'
  },
  link: {
    color: '#2196F3',
    textAlign: 'center',
    marginTop: 10
  }
});
