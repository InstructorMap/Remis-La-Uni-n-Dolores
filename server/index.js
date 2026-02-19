const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

// ============================================
// SUPABASE CONFIG
// ============================================
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ============================================
// CALCULATOR LOGIC
// ============================================
function calculateFare(distanceKm, durationMin) {
  const BASE_FARE = 50;
  const KM_RATE = 10;
  const TIME_RATE = 2;
  const COMMISSION_RATE = 0.2;
  
  const distanceCharge = distanceKm * KM_RATE;
  const timeCharge = durationMin * TIME_RATE;
  const subtotal = BASE_FARE + distanceCharge + timeCharge;
  const commission = subtotal * COMMISSION_RATE;
  const total = subtotal + commission;
  
  return {
    base: BASE_FARE,
    distance: distanceCharge,
    time: timeCharge,
    commission,
    total: Math.round(total)
  };
}

function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
          Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) *
          Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

async function getRouteDistance(pickup, dropoff) {
  const distance = getDistance(pickup.lat, pickup.lng, dropoff.lat, dropoff.lng);
  const duration = distance * 2;
  return { distance, duration };
}

// ============================================
// MIDDLEWARE
// ============================================
const verifyToken = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error) return res.status(401).json({ error: 'Invalid token' });
  
  req.user = user;
  req.token = token;
  next();
};

// ============================================
// ROUTES
// ============================================
// Profile
app.get('/profile', verifyToken, async (req, res) => {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', req.user.id)
    .single();
  
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// Switch role
app.post('/switch-role', verifyToken, async (req, res) => {
  const { role } = req.body;
  
  const { data, error } = await supabase
    .from('profiles')
    .update({ current_role: role })
    .eq('id', req.user.id)
    .select()
    .single();
  
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// Get rides
app.get('/rides', verifyToken, async (req, res) => {
  const { data, error } = await supabase
    .from('rides')
    .select('*')
    .or(`passenger_id.eq.${req.user.id},driver_id.eq.${req.user.id}`)
    .order('created_at', { ascending: false });
  
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// Complete ride
app.post('/rides/:id/complete', verifyToken, async (req, res) => {
  const { id } = req.params;
  
  const { data: ride, error: fetchError } = await supabase
    .from('rides')
    .select('*')
    .eq('id', id)
    .single();
  
  if (fetchError) return res.status(404).json({ error: 'Ride not found' });
  if (ride.driver_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
  
  const { data, error } = await supabase
    .from('rides')
    .update({ status: 'completed', ended_at: new Date() })
    .eq('id', id)
    .select()
    .single();
  
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ============================================
// WEBSOCKETS
// ============================================
const activeDrivers = new Map();
const rideRequests = new Map();

io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication required'));
  
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error) return next(error);
  socket.user = user;
  next();
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.user.id);

  socket.on('driver-location', ({ lat, lng }) => {
    activeDrivers.set(socket.id, { driverId: socket.user.id, lat, lng });
  });

  socket.on('request-ride', async ({ pickup, dropoff }) => {
    const { distance, duration } = await getRouteDistance(pickup, dropoff);
    const fare = calculateFare(distance, duration);
    
    const requestId = Math.random().toString(36).substr(2, 9);
    rideRequests.set(requestId, {
      passengerId: socket.user.id,
      pickup,
      dropoff,
      fare,
      distance,
      duration
    });

    activeDrivers.forEach((driver, driverSocketId) => {
      const distanceToPickup = getDistance(driver.lat, driver.lng, pickup.lat, pickup.lng);
      if (distanceToPickup < 5) {
        io.to(driverSocketId).emit('new-ride-request', { requestId, pickup, dropoff, fare });
      }
    });

    socket.emit('request-sent', { requestId, fare });
  });

  socket.on('accept-ride', ({ requestId }) => {
    const request = rideRequests.get(requestId);
    if (!request) return;

    const driver = activeDrivers.get(socket.id);
    if (!driver) return;

    supabase.from('rides').insert({
      passenger_id: request.passengerId,
      driver_id: driver.driverId,
      pickup: request.pickup,
      dropoff: request.dropoff,
      fare: request.fare,
      status: 'accepted'
    }).then(({ data, error }) => {
      if (error) return;
      
      io.to(request.passengerId).emit('ride-accepted', { 
        driverId: driver.driverId,
        driverLocation: { lat: driver.lat, lng: driver.lng }
      });
      
      socket.emit('ride-started', { rideId: data[0].id });
      rideRequests.delete(requestId);
    });
  });

  socket.on('disconnect', () => {
    activeDrivers.delete(socket.id);
  });
});

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
